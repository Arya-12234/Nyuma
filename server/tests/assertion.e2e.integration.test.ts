import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import pg from "pg";
import { requestAssertion } from "../src/assertion/client.js";
import { isMintedAssertionWire } from "../src/assertion/canonical.js";
import { loadSignerSettings } from "../src/assertion/config.js";
import { createSigner, listenOnLoopback, type SignerLogEvent } from "../src/assertion/main.js";
import { AssertionClientError } from "../src/assertion/client.js";
import { verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { createPostgresCoordinationStore, type CoordinationStore } from "../src/coordination/store.js";
import { createPostgresIdentityStore, type IdentityStore } from "../src/auth/identity.js";
import { IDENTITY_MODE_LOCAL_HS256_TEST, loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { configureIdentityMode, useIdentity, withPooledSession } from "../src/db/session.js";
import { runTransaction } from "../src/db/transaction.js";
import { start } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const issuer = "https://nyuma-local-test.supabase.co/auth/v1";
const credential = "local-e2e-signer-credential-32bx";
const kid = "e2e-signer";
const hmacKey = randomBytes(32);
const hs256Secret = "e2e-hs256-test-secret-32-bytes!!";

let nowSeconds = (): number => Math.floor(Date.now() / 1000);
let admin: pg.Client;
let pool: pg.Pool;
let signer: Server | null = null;
let api: Server | null = null;
let identities: IdentityStore | null = null;
let coordination: CoordinationStore | null = null;
let apiBase = "";
let appUrl = "";
let subject = "";
let accountId = "";
let accessToken = "";
let verification: TokenCheck;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwtKeys: JWTVerifyGetKey;
let signerLogs: SignerLogEvent[] = [];

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") throw new Error("DATABASE_URL is required.");
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    NYUMA_IDENTITY_MODE: "local-hs256-test",
  });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  const parsed = new URL(config.databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "5433" || parsed.pathname !== "/nyuma_dev") {
    throw new Error("Refusing a database other than 127.0.0.1:5433/nyuma_dev.");
  }
  await applyMigrations(config.databaseUrl);
  admin = await connectClient(config.databaseUrl);
  const cluster = await admin.query<{ port: number; version: string }>(
    "SELECT inet_server_port() AS port, current_setting('server_version') AS version",
  );
  expect(cluster.rows[0]).toMatchObject({ port: 5433 });
  expect(cluster.rows[0]?.version.startsWith("18.4")).toBe(true);

  subject = randomUUID();
  const user = await admin.query<{ id: string }>(
    "INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id::text AS id",
    [subject],
  );
  accountId = user.rows[0]?.id ?? "";
  await admin.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer')", [accountId]);
  await admin.query(
    "INSERT INTO nyuma_private.assertion_keys (kid, secret, state) VALUES ($1, $2, 'active')",
    [kid, hmacKey],
  );

  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey) as JWK;
  jwk.alg = "ES256";
  jwk.kid = "e2e-es256";
  signingKey = pair.privateKey;
  jwtKeys = createLocalJWKSet({ keys: [jwk] });
  verification = { issuer, audience: "authenticated", keys: jwtKeys, algorithms: ["ES256"] };
  accessToken = await signSupabase(signingKey, jwk.kid);
  signer = createSigner(loadSignerSettings(signerEnv(), jwtKeys), {
    nowSeconds: () => nowSeconds(),
    log: (event) => signerLogs.push(event),
  });
  const signerPort = await listenOnLoopback(signer, 8791);
  expect(signerPort).toBe(8791);
  expect(signer.address()).toMatchObject({ address: "127.0.0.1", port: 8791 });

  const app = new URL(config.databaseUrl);
  app.username = "nyuma_api";
  app.password = "";
  appUrl = app.toString();
  pool = new pg.Pool({ connectionString: appUrl, max: 1, connectionTimeoutMillis: 3000 });
  identities = createPostgresIdentityStore(appUrl);
  coordination = createPostgresCoordinationStore(appUrl);
  api = await start({
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    NYUMA_IDENTITY_MODE: "signer",
    SIGNER_CLIENT_CREDENTIAL: credential,
  }, {
    identities,
    coordination,
    auth: null,
    verifyToken: (token) => verifyAccessToken(token, verification),
  });
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("The API did not bind a local port.");
  apiBase = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  nowSeconds = () => Math.floor(Date.now() / 1000);
  if (api) {
    const current = api;
    api = null;
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
  }
  configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
  if (signer) {
    const current = signer;
    signer = null;
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
  }
  if (identities) await identities.close();
  if (coordination) await coordination.close();
  if (pool) await pool.end();
  if (admin) {
    await admin.query("DELETE FROM listings WHERE owner_id = $1", [accountId]).catch(() => undefined);
    await admin.query("DELETE FROM user_roles WHERE user_id = $1", [accountId]).catch(() => undefined);
    await admin.query("DELETE FROM users WHERE id = $1", [accountId]).catch(() => undefined);
    await admin.query("DELETE FROM nyuma_private.assertion_keys WHERE kid = ANY($1::text[])", [[kid, "e2e-missing"]]).catch(() => undefined);
    await admin.query("DELETE FROM nyuma_private.local_test_hmac_keys WHERE kid = 'e2e-hs256-off'").catch(() => undefined);
    await admin.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id").catch(() => undefined);
    const state = await admin.query<{
      hs256: boolean;
      hs_keys: number;
      assertion_keys: number;
      listings: number;
    }>(`
      SELECT (SELECT local_hs256_enabled FROM nyuma_private.verifier_config) AS hs256,
             (SELECT count(*)::int FROM nyuma_private.local_test_hmac_keys WHERE kid = 'e2e-hs256-off') AS hs_keys,
             (SELECT count(*)::int FROM nyuma_private.assertion_keys WHERE kid = ANY($1::text[])) AS assertion_keys,
             (SELECT count(*)::int FROM listings WHERE owner_id = $2) AS listings
    `, [[kid, "e2e-missing"], accountId]);
    expect(state.rows[0]).toEqual({ hs256: false, hs_keys: 0, assertion_keys: 0, listings: 0 });
    await admin.end();
  }
}, 30000);

describe("signer to database identity", () => {
  it("creates a listing from a Supabase JWT through the signer, the API, and PostgreSQL", async () => {
    const before = signerLogs.length;
    const response = await postJson(`${apiBase}/me/listings`, accessToken, draftListing());
    expect(response.status).toBe(201);
    const listing = (response.body as { listing: { id: string; ownerId: string } }).listing;
    expect(listing.ownerId).toBe(accountId);
    const stored = await admin.query<{ owner_id: string }>("SELECT owner_id::text AS owner_id FROM listings WHERE id = $1", [listing.id]);
    expect(stored.rows[0]?.owner_id).toBe(accountId);
    const minted = signerLogs.slice(before);
    expect(minted).toEqual([{ status: 200, code: "ok" }, { status: 200, code: "ok" }]);
    const recorded = JSON.stringify(minted);
    expect(recorded).not.toContain(accessToken);
    expect(recorded).not.toContain(credential);
    expect(recorded).not.toContain(hmacKey.toString("hex"));
    expect(recorded).not.toContain(hmacKey.toString("base64url"));
  });

  it("stores the assertion only for the transaction and clears it before reuse", async () => {
    const id = listingId();
    const seen = await withPooledSession(pool, accessToken, async (client) => {
      const row = await client.query<{ token: string; sub: string; account: string }>(`
        SELECT current_setting('nyuma.access_token', true) AS token,
               nyuma_verified_sub()::text AS sub,
               nyuma_verified_account_id()::text AS account
      `);
      await client.query("SELECT nyuma_lock_user($1)", [accountId]);
      await client.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind,
           location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Mango', 4.000, 'kg', 'available', 'Kitui', 'Today', 20.00, 'draft')`,
        [id, accountId],
      );
      return row.rows[0];
    });
    expect(seen?.sub).toBe(subject);
    expect(seen?.account).toBe(accountId);
    expect(seen?.token.startsWith("nya1.")).toBe(true);
    expect(seen?.token).not.toBe(accessToken);
    expect(isMintedAssertionWire(seen?.token ?? "")).toBe(true);
    const kept = await admin.query("SELECT 1 FROM listings WHERE id = $1", [id]);
    expect(kept.rowCount).toBe(1);
    const reused = await withPooledSession(pool, null, async (client) => {
      const row = await client.query<{ token: string | null; sub: string | null }>(`
        SELECT current_setting('nyuma.access_token', true) AS token,
               nyuma_verified_sub()::text AS sub
      `);
      return row.rows[0];
    });
    expect(reused).toEqual({ token: "", sub: null });
  });

  it("rolls a verified write back and leaves the next checkout anonymous", async () => {
    const id = listingId();
    await expect(withPooledSession(pool, accessToken, async (client) => {
      const row = await client.query<{ sub: string }>("SELECT nyuma_verified_sub()::text AS sub");
      expect(row.rows[0]?.sub).toBe(subject);
      await client.query("SELECT nyuma_lock_user($1)", [accountId]);
      await client.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind,
           location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Tomato', 1.000, 'kg', 'available', 'Nairobi', 'Tomorrow', 15.00, 'draft')`,
        [id, accountId],
      );
      throw new Error("application rejected the write");
    })).rejects.toThrow("application rejected the write");
    const kept = await admin.query("SELECT 1 FROM listings WHERE id = $1", [id]);
    expect(kept.rowCount).toBe(0);
    await expect(clearedSession()).resolves.toEqual({ token: "", sub: null });
  });

  it("obtains a new assertion after a serialization failure", async () => {
    const base = Math.floor(Date.now() / 1000);
    let step = 0;
    nowSeconds = () => base + step++;
    const before = signerLogs.length;
    const seen: string[] = [];
    try {
      let attempts = 0;
      await withPooledSession(pool, accessToken, (client) => runTransaction(client, async (tx) => {
        attempts += 1;
        const row = await tx.query<{ token: string; sub: string }>(`
          SELECT current_setting('nyuma.access_token', true) AS token,
                 nyuma_verified_sub()::text AS sub
        `);
        seen.push(row.rows[0]?.token ?? "");
        expect(row.rows[0]?.sub).toBe(subject);
        await tx.query("SELECT nyuma_lock_user($1)", [accountId]);
        if (attempts === 1) throw Object.assign(new Error("serialization failure"), { code: "40001" });
        return "saved";
      }));
      expect(attempts).toBe(2);
    } finally {
      nowSeconds = () => Math.floor(Date.now() / 1000);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(accessToken);
    expect(seen[1]).not.toBe(accessToken);
    expect(seen.every((value) => value.startsWith("nya1."))).toBe(true);
    expect(signerLogs.slice(before).filter((event) => event.code === "ok").length).toBeGreaterThanOrEqual(2);
    await expect(clearedSession()).resolves.toEqual({ token: "", sub: null });
  });

  it("rejects a bad Supabase token at the API and the signer, and does not verify the raw bearer", async () => {
    const cases = [
      await signSupabase(signingKey, "e2e-es256", { mutate: "signature" }),
      await signSupabase(signingKey, "e2e-es256", { issuer: "https://wrong.supabase.co/auth/v1" }),
      await signSupabase(signingKey, "e2e-es256", { audience: "anon" }),
      await signSupabase(signingKey, "e2e-es256", { role: "service_role" }),
      await signSupabase(signingKey, "e2e-es256", { expirationTime: Math.floor(Date.now() / 1000) - 10 }),
      await signSupabase(signingKey, "e2e-es256", { subject: subject.toUpperCase() }),
      await signSupabase(signingKey, "e2e-es256", { subject: mixedCase(subject) }),
    ];
    for (const token of cases) {
      const http = await postJson(`${apiBase}/me/listings`, token, draftListing());
      expect(http.status).toBe(401);
      expect(JSON.stringify(http.body)).not.toContain(token);
      const direct = await postSigner(token);
      expect(direct.status).toBe(401);
      expect(direct.body).toBe("invalid-token");
      expect(direct.body).not.toContain(token);
      expect(await subjectFor(token)).toBeNull();
    }
    expect(JSON.stringify(signerLogs)).not.toContain(credential);
    expect(JSON.stringify(signerLogs)).not.toContain(hmacKey.toString("hex"));
  });

  it("fails closed when the signer credential, signer, or signer response cannot mint", async () => {
    expect(() => loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test",
      NYUMA_IDENTITY_MODE: "signer",
    })).toThrow(/SIGNER_CLIENT_CREDENTIAL/);
    expect(() => loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test",
      NYUMA_IDENTITY_MODE: "signer",
      SIGNER_CLIENT_CREDENTIAL: credential,
      ASSERTION_HMAC_KEY: hmacKey.toString("base64url"),
    })).toThrow(/assertion signing key/);
    expect(() => loadSignerSettings({ ...signerEnv(), DATABASE_URL: "postgres://nyuma@127.0.0.1:5433/nyuma_dev" })).toThrow(/database/);

    const restore = useIdentity("signer", null);
    try {
      let ran = false;
      await expect(withPooledSession(pool, accessToken, async () => {
        ran = true;
        return "no";
      })).rejects.toBeInstanceOf(AssertionClientError);
      expect(ran).toBe(false);
    } finally {
      restore();
    }

    const closed = await closedEndpoint();
    const unavailable = useIdentity("signer", (token) => requestAssertion(token, credential, { endpoint: closed }));
    try {
      let ran = false;
      const error = await failureOf(withPooledSession(pool, accessToken, async () => {
        ran = true;
        return "no";
      }));
      expect(ran).toBe(false);
      expect(error.name).toBe("AssertionClientError");
      expect(error.message).toBe("The assertion signer request failed.");
      expect(error.message).not.toContain(accessToken);
      expect(error.message).not.toContain(credential);
    } finally {
      unavailable();
    }

    const malformed = await textServer("not-an-assertion");
    const malformedIdentity = useIdentity("signer", (token) => requestAssertion(token, credential, { endpoint: malformed.url }));
    try {
      let ran = false;
      await expect(withPooledSession(pool, accessToken, async () => {
        ran = true;
        return "no";
      })).rejects.toBeInstanceOf(AssertionClientError);
      expect(ran).toBe(false);
    } finally {
      malformedIdentity();
      await malformed.close();
    }
    await expect(clearedSession()).resolves.toEqual({ token: "", sub: null });
  });

  it("rejects an invalid, expired, unknown, or retired assertion without using HS256", async () => {
    const minted = await requestAssertion(accessToken, credential);
    const corrupt = corruptMac(minted);
    expect(isMintedAssertionWire(corrupt)).toBe(true);
    const badMac = await textServer(corrupt);
    const badMacIdentity = useIdentity("signer", (token) => requestAssertion(token, credential, { endpoint: badMac.url }));
    try {
      await expect(lockAccount()).rejects.toMatchObject({ code: "42501" });
    } finally {
      badMacIdentity();
      await badMac.close();
    }

    const expired = await signerOn(signerEnv(), () => Math.floor(Date.now() / 1000) - 121);
    const expiredIdentity = useIdentity("signer", (token) => requestAssertion(token, credential, { endpoint: expired.url }));
    try {
      await expect(lockAccount()).rejects.toMatchObject({ code: "42501" });
    } finally {
      expiredIdentity();
      await expired.close();
    }

    const unknown = await signerOn({ ...signerEnv(), ASSERTION_KEY_ID: "e2e-missing" }, () => Math.floor(Date.now() / 1000));
    const unknownIdentity = useIdentity("signer", (token) => requestAssertion(token, credential, { endpoint: unknown.url }));
    try {
      await expect(lockAccount()).rejects.toMatchObject({ code: "42501" });
    } finally {
      unknownIdentity();
      await unknown.close();
    }

    await admin.query(
      "UPDATE nyuma_private.assertion_keys SET state = 'retired', secret = NULL WHERE kid = $1",
      [kid],
    );
    try {
      await expect(lockAccount()).rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin.query(
        "UPDATE nyuma_private.assertion_keys SET state = 'active', secret = $2 WHERE kid = $1",
        [kid, hmacKey],
      );
    }
    await expect(clearedSession()).resolves.toEqual({ token: "", sub: null });
  });

  it("does not accept a raw bearer or a forged HS256 token while the database flag is false", async () => {
    expect(await subjectFor(accessToken)).toBeNull();
    const config = await admin.query<{ issuer: string; audience: string; enabled: boolean }>(
      "SELECT issuer, audience, local_hs256_enabled AS enabled FROM nyuma_private.verifier_config",
    );
    expect(config.rows[0]?.enabled).toBe(false);
    await admin.query(
      "INSERT INTO nyuma_private.local_test_hmac_keys (kid, secret) VALUES ('e2e-hs256-off', $1)",
      [hs256Secret],
    );
    try {
      const forged = await new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "HS256", kid: "e2e-hs256-off" })
        .setSubject(subject)
        .setIssuer(config.rows[0]?.issuer ?? "")
        .setAudience(config.rows[0]?.audience ?? "")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(hs256Secret));
      expect(await subjectFor(forged)).toBeNull();
      const http = await postJson(`${apiBase}/me/listings`, forged, draftListing());
      expect(http.status).toBe(401);
      const direct = await postSigner(forged);
      expect(direct.status).toBe(401);
      expect(direct.body).toBe("invalid-token");
    } finally {
      await admin.query("DELETE FROM nyuma_private.local_test_hmac_keys WHERE kid = 'e2e-hs256-off'");
    }
    const flag = await admin.query<{ enabled: boolean }>(
      "SELECT local_hs256_enabled AS enabled FROM nyuma_private.verifier_config",
    );
    expect(flag.rows[0]?.enabled).toBe(false);
  });

  it("keeps assertion keys and verifier configuration away from nyuma_api", async () => {
    const apiClient = await connectClient(appUrl);
    try {
      expect((await failureOf(apiClient.query("SELECT kid FROM nyuma_private.assertion_keys"))).code).toBe("42501");
      expect((await failureOf(apiClient.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true"))).code).toBe("42501");
      expect((await failureOf(apiClient.query("SET ROLE nyuma_fn_identity"))).code).toBe("42501");
    } finally {
      await apiClient.end();
    }
  });

  it("logs a signer outage without the bearer, assertion, or credential", async () => {
    const current = signer;
    signer = null;
    await new Promise<void>((resolve, reject) => current?.close((error) => (error ? reject(error) : resolve())));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await postJson(`${apiBase}/me/listings`, accessToken, draftListing());
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: "request-failed" });
      const logged = spy.mock.calls.flat().map((value) => String(value)).join("\n");
      expect(logged).toBe("request failed");
      expect(logged).not.toContain(accessToken);
      expect(logged).not.toContain(credential);
      expect(logged).not.toContain("nya1.");
    } finally {
      spy.mockRestore();
    }
  });
});

function signerEnv(): Record<string, string | undefined> {
  return {
    SIGNER_HOST: "127.0.0.1",
    SIGNER_PORT: "8791",
    ASSERTION_KEY_ID: kid,
    ASSERTION_HMAC_KEY: hmacKey.toString("base64url"),
    SIGNER_CLIENT_CREDENTIAL: credential,
    SUPABASE_URL: "https://nyuma-local-test.supabase.co",
  };
}

function draftListing(): Record<string, unknown> {
  return {
    commodity: "Watermelon",
    quantity: 10.5,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40.25,
    status: "draft",
  };
}

function listingId(): string {
  return `e2e${randomBytes(8).toString("hex")}`;
}

function mixedCase(value: string): string {
  const chars = value.split("");
  const lower = chars.findIndex((char) => char >= "a" && char <= "f");
  const later = chars.findIndex((char, index) => index > lower && char >= "a" && char <= "f");
  if (lower < 0 || later < 0) throw new Error("The subject has no letters to mix.");
  chars[lower] = chars[lower]!.toUpperCase();
  return chars.join("");
}

async function signSupabase(
  key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  keyId: string,
  overrides: {
    issuer?: string;
    audience?: string;
    role?: string;
    subject?: string;
    expirationTime?: number;
    mutate?: "signature";
  } = {},
): Promise<string> {
  const signed = await new SignJWT({ role: overrides.role ?? "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setSubject(overrides.subject ?? subject)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? "10m")
    .sign(key);
  if (overrides.mutate !== "signature") return signed;
  const [header, payload, signature] = signed.split(".");
  const bytes = Buffer.from(signature ?? "", "base64url");
  bytes[0] ^= 0xff;
  return `${header}.${payload}.${bytes.toString("base64url")}`;
}

async function postJson(url: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) as unknown };
}

async function postSigner(token: string): Promise<{ status: number; body: string }> {
  const response = await fetch("http://127.0.0.1:8791/assertions", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return { status: response.status, body: await response.text() };
}

async function subjectFor(token: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('nyuma.access_token', $1, true)", [token]);
    const row = await client.query<{ sub: string | null }>("SELECT nyuma_verified_sub()::text AS sub");
    await client.query("ROLLBACK");
    return row.rows[0]?.sub ?? null;
  } finally {
    client.release();
  }
}

async function clearedSession(): Promise<{ token: string | null; sub: string | null }> {
  return withPooledSession(pool, null, async (client) => {
    const row = await client.query<{ token: string | null; sub: string | null }>(`
      SELECT current_setting('nyuma.access_token', true) AS token,
             nyuma_verified_sub()::text AS sub
    `);
    return row.rows[0] ?? { token: null, sub: null };
  });
}

function lockAccount(): Promise<unknown> {
  return withPooledSession(pool, accessToken, async (client) => {
    await client.query("SELECT nyuma_lock_user($1)", [accountId]);
  });
}

function corruptMac(wire: string): string {
  const [prefix, payload, mac] = wire.split(".");
  const bytes = Buffer.from(mac ?? "", "base64url");
  bytes[0] ^= 0xff;
  return `${prefix}.${payload}.${bytes.toString("base64url")}`;
}

async function failureOf(work: Promise<unknown>): Promise<{ name: string; message: string; code: string }> {
  try {
    await work;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return { name, message, code };
  }
  throw new Error("The operation succeeded.");
}

async function closedEndpoint(): Promise<string> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : 0);
    });
  });
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return `http://127.0.0.1:${port}/assertions`;
}

async function textServer(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/assertions`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function signerOn(
  env: Record<string, string | undefined>,
  clock: () => number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createSigner(loadSignerSettings(env, jwtKeys), { nowSeconds: clock });
  const port = await listenOnLoopback(server, 0);
  return {
    url: `http://127.0.0.1:${port}/assertions`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
