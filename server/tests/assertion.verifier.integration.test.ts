import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { ClientBase } from "pg";
import { signTestToken } from "../src/auth/tokens.js";
import {
  encodeCanonicalPayload,
  macCanonicalPayload,
  mintAssertion,
  wireAssertion,
  type CanonicalFields,
} from "../src/assertion/canonical.js";
import { IDENTITY_MODE_LOCAL_HS256_TEST, IDENTITY_MODE_SIGNER, loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { configureAssertionSource, configureIdentityMode, withPooledSession } from "../src/db/session.js";

const databaseUrl = process.env.DATABASE_URL;
const vectorKey = Buffer.alloc(32, 0x01);
const vectorPayload = "6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383433323000000000";
const vectorMac = "d58a97bfbc03607a180c4a501f7efb63d936cfafc6c59edc4b11c9e787bf82ca";
const shortPayload = "6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383432303500000000";
const shortMac = "677e169c3cd410b0ea2ec76ca3d85d63d76be9e000dc04691102c6107de6b441";
const shortWire = "nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDIwNQAAAAA.Z34WnDzUELDqLsdso9hdY9dr6eAA3ARpEQLGEH3mtEE";
const acceptanceWire = "nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDMyMAAAAAA.1YqXv7wDYHoYDEpQH377Y9k2z6_GxZ7cSxHJ54e_gso";

let admin: pg.Client;
let pool: pg.Pool;
let accountA = "";
let accountB = "";
let suspendedId = "";
let subjectA = "";
let subjectB = "";
let suspendedSubject = "";
const secondKey = randomBytes(32);

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Assertion verifier integration was not skipped and was not run.");
  }
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    NYUMA_IDENTITY_MODE: "local-hs256-test",
  });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  const applied = await applyMigrations(config.databaseUrl);
  console.log(`Assertion verifier migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  admin = await connectClient(config.databaseUrl);
  const cluster = await admin.query<{ db: string; port: number; version: string }>(
    `SELECT current_database() AS db, inet_server_port() AS port, current_setting('server_version') AS version`,
  );
  expect(cluster.rows[0]).toMatchObject({ db: "nyuma_dev", port: 5433 });
  expect(cluster.rows[0]?.version.startsWith("18.4")).toBe(true);
  subjectA = randomUUID();
  subjectB = randomUUID();
  suspendedSubject = randomUUID();
  const inserted = await admin.query<{ id: string; auth_user_id: string }>(
    `INSERT INTO users (auth_user_id) VALUES ($1), ($2), ($3)
     RETURNING id::text AS id, auth_user_id::text AS auth_user_id`,
    [subjectA, subjectB, suspendedSubject],
  );
  accountA = inserted.rows.find((row) => row.auth_user_id === subjectA)?.id ?? "";
  accountB = inserted.rows.find((row) => row.auth_user_id === subjectB)?.id ?? "";
  suspendedId = inserted.rows.find((row) => row.auth_user_id === suspendedSubject)?.id ?? "";
  await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspendedId]);
  await admin.query(
    `INSERT INTO nyuma_private.assertion_keys (kid, secret, state)
     VALUES ('test-key', $1, 'active'), ('second-key', $2, 'active')`,
    [vectorKey, secondKey],
  );
  const parsed = new URL(config.databaseUrl);
  parsed.username = "nyuma_api";
  parsed.password = "";
  pool = new pg.Pool({ connectionString: parsed.toString(), max: 1, connectionTimeoutMillis: 3000 });
}, 30000);

afterAll(async () => {
  configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
  configureAssertionSource(null);
  await pool?.end();
  if (!admin) return;
  await admin.query("DELETE FROM nyuma_private.assertion_keys WHERE kid IN ('test-key', 'second-key')").catch(() => undefined);
  await admin.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[accountA, accountB, suspendedId]]).catch(() => undefined);
  await admin.end();
});

describe("PostgreSQL nya1 verifier", () => {
  it("matches the published HMAC vectors and accepts a current 120-second assertion", async () => {
    const macs = await admin.query<{ vector: string; short: string }>(
      `SELECT encode(nyuma_private.hmac(decode($1, 'hex'), $3, 'sha256'), 'hex') AS vector,
              encode(nyuma_private.hmac(decode($2, 'hex'), $3, 'sha256'), 'hex') AS short`,
      [vectorPayload, shortPayload, vectorKey],
    );
    expect(macs.rows[0]).toEqual({ vector: vectorMac, short: shortMac });
    expect(await verified(acceptanceWire)).toEqual({ sub: null, accountId: null, status: null });
    expect(await verified(shortWire)).toEqual({ sub: null, accountId: null, status: null });

    const now = await nowSeconds();
    const wire = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
    const active = await verified(wire);
    expect(active.sub).toBe(subjectA);
    expect(active.accountId).toBe(accountA);
    const nbfNow = await nowSeconds();
    const withNbf = signed({ kid: "test-key", sub: subjectA, iat: nbfNow, exp: nbfNow + 120, nbf: nbfNow, jti: subjectB });
    expect(await subjectOnly(withNbf)).toBe(subjectA);
    const ahead = await nowSeconds();
    expect(await subjectOnly(mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: ahead + 1 }))).toBe(subjectA);
    const otherNow = await nowSeconds();
    const other = await verified(mintAssertion({ key: secondKey, kid: "second-key", sub: subjectB, iat: otherNow }));
    expect(other).toEqual({ sub: subjectB, accountId: accountB, status: "active" });
  });

  it("rejects malformed, mistimed, and wrongly keyed assertions", async () => {
    const now = await nowSeconds();
    const valid = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
    const [prefixText, body, mac] = valid.split(".");
    expect(await subjectOnly(corruptMac(valid))).toBeNull();
    expect(await subjectOnly(`${prefixText}.${body}A.${mac}`)).toBeNull();
    expect(await subjectOnly(`${prefixText}.${body}+.${mac}`)).toBeNull();
    expect(await subjectOnly(mintAssertion({ key: vectorKey, kid: "missing-key", sub: subjectA, iat: now }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", sub: subjectA.toUpperCase(), iat: now, exp: now + 120 }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", sub: "58060E06-2f2a-4645-a8de-b4cc00414533", iat: now, exp: now + 120 }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", iss: "other-assertion", sub: subjectA, iat: now, exp: now + 120 }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", aud: "nyuma-xx", sub: subjectA, iat: now, exp: now + 120 }))).toBeNull();
    const boundary = await nowSeconds();
    expect(await subjectOnly(signed({ kid: "test-key", sub: subjectA, iat: boundary - 120, exp: boundary }))).toBeNull();
    const skewed = await nowSeconds();
    expect(await subjectOnly(signed({ kid: "test-key", sub: subjectA, iat: skewed + 30, exp: skewed + 150 }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", sub: subjectA, iat: skewed, exp: skewed + 5 }))).toBeNull();
    expect(await subjectOnly(signed({ kid: "test-key", sub: subjectA, iat: skewed + 1, exp: skewed + 121, nbf: skewed + 30 }))).toBeNull();
    await expectFutureNbfRejected();
    expect(await verified(null)).toEqual({ sub: null, accountId: null, status: null });
    expect(await subjectOnly("")).toBeNull();
    expect(await subjectOnly("   ")).toBeNull();
    expect(await subjectOnly("nya1")).toBeNull();
    expect(await subjectOnly("nya1.%%%%.AAAA")).toBeNull();
    expect(await subjectOnly(`${valid}=`)).toBeNull();
    expect(await subjectOnly(` ${valid}`)).toBeNull();
    expect(await subjectOnly(`${valid} `)).toBeNull();
    expect(await subjectOnly("x".repeat(9000))).toBeNull();
    expect(await subjectOnly(truncatedWire(now))).toBeNull();
    expect(await subjectOnly(badLengthWire())).toBeNull();
    expect(await subjectOnly(trailingWire(now))).toBeNull();
    expect(await subjectOnly(missingFieldWire(now))).toBeNull();
    await expectAcceptedBeforeExpiry();
  }, 20000);

  it("verifies a retiring key and returns null after the secret is erased", async () => {
    try {
      await admin.query("UPDATE nyuma_private.assertion_keys SET state = 'retiring' WHERE kid = 'test-key'");
      const retiringNow = await nowSeconds();
      expect(await subjectOnly(mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: retiringNow }))).toBe(subjectA);
      await admin.query(
        `UPDATE nyuma_private.assertion_keys SET state = 'retired', secret = NULL WHERE kid = 'test-key'`,
      );
      const retiredNow = await nowSeconds();
      expect(await subjectOnly(mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: retiredNow }))).toBeNull();
      expect(await subjectOnly(mintAssertion({ key: secondKey, kid: "second-key", sub: subjectB, iat: retiredNow }))).toBe(subjectB);
    } finally {
      await admin.query(
        `UPDATE nyuma_private.assertion_keys SET state = 'active', secret = $1 WHERE kid = 'test-key'`,
        [vectorKey],
      );
    }
  });

  it("keeps the API away from keys and does not accept another account or a suspended account", async () => {
    const now = await nowSeconds();
    const wire = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
    const seen = await verified(wire);
    expect(seen.accountId).toBe(accountA);
    expect(seen.accountId).not.toBe(accountB);
    const suspended = await verified(mintAssertion({ key: vectorKey, kid: "test-key", sub: suspendedSubject, iat: now }));
    expect(suspended.sub).toBe(suspendedSubject);
    expect(suspended.accountId).toBeNull();
    expect(suspended.status).toBe("suspended");
    await expect(apiQuery("SELECT secret FROM nyuma_private.assertion_keys")).rejects.toThrow(/permission denied/);
    await expect(apiQuery("UPDATE nyuma_private.assertion_keys SET state = 'retired'")).rejects.toThrow(/permission denied/);
    await expect(apiQuery("SET ROLE nyuma_fn_identity")).rejects.toThrow(/permission denied/);
    await expect(apiQuery("SET ROLE nyuma_owner")).rejects.toThrow(/permission denied/);
    const shadowed = await withPooledSession(pool, wire, async (client) => {
      await client.query("CREATE TEMP TABLE assertion_keys (kid text, secret bytea, state text) ON COMMIT DROP");
      await client.query("CREATE TEMP TABLE users (id uuid, auth_user_id uuid, status text) ON COMMIT DROP");
      await client.query("INSERT INTO users (id, auth_user_id, status) VALUES ($1, $2, 'active')", [accountB, subjectA]);
      return verifiedRow(client);
    });
    expect(shadowed.accountId).toBe(accountA);
  });

  it("drops the assertion on rollback and does not reuse it on the next connection checkout", async () => {
    const now = await nowSeconds();
    const wire = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
    await expect(withPooledSession(pool, wire, async (client) => {
      expect((await verifiedRow(client)).sub).toBe(subjectA);
      throw new Error("rollback this assertion");
    })).rejects.toThrow("rollback this assertion");
    expect(await verified(null)).toEqual({ sub: null, accountId: null, status: null });
    expect((await verified(wire)).sub).toBe(subjectA);
  });

  it("verifies nya1 while HS256 stays disabled and does not fall back", async () => {
    const hs256Secret = "verifier-disabled-hs256-secret-32b";
    const adminClient = admin;
    try {
      await adminClient.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id");
      await adminClient.query(
        "INSERT INTO nyuma_private.local_test_hmac_keys (kid, secret) VALUES ('verifier-hs256-off', $1)",
        [hs256Secret],
      );
      const now = await nowSeconds();
      const wire = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
      expect((await verified(wire)).sub).toBe(subjectA);
      const bearer = await signTestToken(new TextEncoder().encode(hs256Secret), {
        subject: subjectA,
        issuer: "https://example-project.supabase.co/auth/v1",
        audience: "authenticated",
        expiresIn: "10m",
      });
      expect(await verified(bearer)).toEqual({ sub: null, accountId: null, status: null });
      expect(await verified(corruptMac(wire))).toEqual({ sub: null, accountId: null, status: null });
    } finally {
      await adminClient.query("DELETE FROM nyuma_private.local_test_hmac_keys WHERE kid = 'verifier-hs256-off'");
      await adminClient.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id");
    }
  });

  it("stores a signer assertion instead of the raw bearer", async () => {
    const now = await nowSeconds();
    const bearer = await signTestToken(new TextEncoder().encode("verifier-test-hs256-secret-32b!!"), {
      subject: subjectB,
      issuer: "https://example-project.supabase.co/auth/v1",
      audience: "authenticated",
      expiresIn: "10m",
    });
    const wire = mintAssertion({ key: vectorKey, kid: "test-key", sub: subjectA, iat: now });
    configureIdentityMode(IDENTITY_MODE_SIGNER);
    configureAssertionSource(async (token) => {
      expect(token).toBe(bearer);
      return wire;
    });
    try {
      const stored = await withPooledSession(pool, bearer, async (client) => {
        const setting = await client.query<{ token: string }>("SELECT current_setting('nyuma.access_token', true) AS token");
        const identity = await verifiedRow(client);
        return { setting: setting.rows[0]?.token, identity };
      });
      expect(stored.setting).toBe(wire);
      expect(stored.setting).not.toBe(bearer);
      expect(stored.identity.sub).toBe(subjectA);
      expect(stored.identity.accountId).toBe(accountA);
    } finally {
      configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
      configureAssertionSource(null);
    }
  });
});

function signed(fields: CanonicalFields & { iss?: string; aud?: string }): string {
  const canonicalSubject = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fields.sub);
  const payload = fields.iss || fields.aud || !canonicalSubject ? rawPayload(fields) : encodeCanonicalPayload(fields);
  return wireAssertion(payload, macCanonicalPayload(vectorKey, payload));
}

function rawPayload(fields: CanonicalFields & { iss?: string; aud?: string }): Buffer {
  const parts = [
    Buffer.from(fields.kid, "ascii"),
    Buffer.from(fields.iss ?? "nyuma-assertion", "ascii"),
    Buffer.from(fields.aud ?? "nyuma-db", "ascii"),
    Buffer.from(fields.sub, "ascii"),
    Buffer.from(String(fields.iat), "ascii"),
    Buffer.from(String(fields.exp), "ascii"),
    fields.nbf == null ? Buffer.alloc(0) : Buffer.from(String(fields.nbf), "ascii"),
    fields.jti ? Buffer.from(fields.jti, "ascii") : Buffer.alloc(0),
  ];
  return Buffer.concat([Buffer.from("nya1", "ascii"), ...parts.map(prefix)]);
}

function prefix(value: Buffer): Buffer {
  const encoded = Buffer.alloc(2 + value.length);
  encoded.writeUInt16BE(value.length, 0);
  value.copy(encoded, 2);
  return encoded;
}

function corruptMac(wire: string): string {
  const [prefixText, payload, mac] = wire.split(".");
  const bytes = Buffer.from(mac!, "base64url");
  bytes[0] ^= 0xff;
  return `${prefixText}.${payload}.${bytes.toString("base64url")}`;
}

function truncatedWire(now: number): string {
  const payload = encodeCanonicalPayload({ kid: "test-key", sub: subjectA, iat: now, exp: now + 120 });
  const short = payload.subarray(0, payload.length - 4);
  return wireAssertion(short, macCanonicalPayload(vectorKey, short));
}

function trailingWire(now: number): string {
  const payload = Buffer.concat([
    encodeCanonicalPayload({ kid: "test-key", sub: subjectA, iat: now, exp: now + 120 }),
    Buffer.from([1]),
  ]);
  return wireAssertion(payload, macCanonicalPayload(vectorKey, payload));
}

function badLengthWire(): string {
  const payload = Buffer.concat([Buffer.from("nya1", "ascii"), Buffer.from([0x00, 0xff]), Buffer.from("x")]);
  return wireAssertion(payload, macCanonicalPayload(vectorKey, payload));
}

function missingFieldWire(now: number): string {
  const payload = encodeCanonicalPayload({ kid: "test-key", sub: subjectA, iat: now, exp: now + 120 });
  const short = payload.subarray(0, payload.length - 2);
  return wireAssertion(short, createHmac("sha256", vectorKey).update(short).digest());
}

async function nowSeconds(): Promise<number> {
  const result = await admin.query<{ now_s: string }>("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now_s");
  return Number(result.rows[0]?.now_s);
}

async function expectFutureNbfRejected(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = await nowSeconds();
    const wire = signed({ kid: "test-key", sub: subjectA, iat: now + 1, exp: now + 121, nbf: now + 1 });
    if ((await subjectOnly(wire)) === null) return;
  }
  throw new Error("A not-before time one second ahead was accepted.");
}

async function expectAcceptedBeforeExpiry(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = await nowSeconds();
    const wire = signed({ kid: "test-key", sub: subjectA, iat: now - 119, exp: now + 1 });
    if ((await subjectOnly(wire)) === subjectA) return;
  }
  throw new Error("An assertion one second before expiration was rejected.");
}

async function verified(token: string | null): Promise<{ sub: string | null; accountId: string | null; status: string | null }> {
  return withPooledSession(pool, token, verifiedRow);
}

async function subjectOnly(token: string): Promise<string | null> {
  return (await verified(token)).sub;
}

async function verifiedRow(client: ClientBase): Promise<{ sub: string | null; accountId: string | null; status: string | null }> {
  const result = await client.query<{ sub: string | null; account_id: string | null; status: string | null }>(
    `SELECT nyuma_verified_sub()::text AS sub,
            nyuma_verified_account_id()::text AS account_id,
            nyuma_account_status() AS status`,
  );
  return {
    sub: result.rows[0]?.sub ?? null,
    accountId: result.rows[0]?.account_id ?? null,
    status: result.rows[0]?.status ?? null,
  };
}

function apiQuery(statement: string): Promise<unknown> {
  return withPooledSession(pool, null, (client) => client.query(statement));
}
