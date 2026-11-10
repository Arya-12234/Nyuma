import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import type { ClientBase } from "pg";
import { signTestToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { withPooledSession } from "../src/db/session.js";

const databaseUrl = process.env.DATABASE_URL;
const issuer = "https://example-project.supabase.co/auth/v1";
const audience = "authenticated";
const secret = randomBytes(32).toString("hex");
const secretKey = new TextEncoder().encode(secret);

let adminUrl = "";
let apiUrl = "";
let pool: pg.Pool | undefined;
let accountA = "";
let accountB = "";
let subjectA = "";
let subjectB = "";
let suspendedSubject = "";

function loginUrl(admin: string, username: string): string {
  const parsed = new URL(admin);
  parsed.username = username;
  parsed.password = "";
  return parsed.toString();
}

async function sign(subject: string, input?: { issuer?: string; audience?: string; expiresIn?: string | number; extra?: Record<string, unknown> }): Promise<string> {
  return signTestToken(secretKey, {
    subject,
    issuer: input?.issuer ?? issuer,
    audience: input?.audience ?? audience,
    expiresIn: input?.expiresIn ?? "10m",
    extra: input?.extra,
  });
}

async function verified(client: ClientBase): Promise<{ sub: string | null; accountId: string | null; status: string | null }> {
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

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Stage B integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  apiUrl = loginUrl(adminUrl, "nyuma_api");
  const applied = await applyMigrations(adminUrl);
  console.log(`Stage B migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  const admin = await connectClient(adminUrl);
  try {
    const extension = await admin.query<{ extversion: string; nspname: string }>(
      `SELECT e.extversion, n.nspname
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto'`,
    );
    expect(extension.rows[0]).toEqual({ extversion: "1.4", nspname: "nyuma_private" });
    const security = await admin.query<{ enabled: boolean }>(
      `SELECT bool_or(c.relrowsecurity OR c.relforcerowsecurity) AS enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(security.rows[0]?.enabled).toBe(false);
    subjectA = randomUUID();
    subjectB = randomUUID();
    suspendedSubject = randomUUID();
    const inserted = await admin.query<{ id: string; auth_user_id: string }>(
      `INSERT INTO users (auth_user_id)
       VALUES ($1), ($2), ($3)
       RETURNING id::text AS id, auth_user_id::text AS auth_user_id`,
      [subjectA, subjectB, suspendedSubject],
    );
    accountA = inserted.rows.find((row) => row.auth_user_id === subjectA)?.id ?? "";
    accountB = inserted.rows.find((row) => row.auth_user_id === subjectB)?.id ?? "";
    const suspendedId = inserted.rows.find((row) => row.auth_user_id === suspendedSubject)?.id;
    await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspendedId]);
    await admin.query(
      `INSERT INTO nyuma_private.verifier_config (id, issuer, audience, local_hs256_enabled)
       VALUES (true, $1, $2, true)
       ON CONFLICT (id) DO UPDATE
         SET issuer = EXCLUDED.issuer,
             audience = EXCLUDED.audience,
             local_hs256_enabled = true`,
      [issuer, audience],
    );
    await admin.query("DELETE FROM nyuma_private.local_test_hmac_keys");
    await admin.query(
      `INSERT INTO nyuma_private.local_test_hmac_keys (kid, secret) VALUES ('local-test', $1)`,
      [secret],
    );
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ connectionString: apiUrl, max: 1, connectionTimeoutMillis: 3000 });
  const mode = await withPooledSession(pool, null, async (client) => {
    const result = await client.query<{ mode: string }>("SELECT nyuma_identity_verification_mode() AS mode");
    return result.rows[0]?.mode ?? "";
  });
  console.log(`Stage B verifier mode: ${mode}. Local HS256 uses a test secret that is not a production key. Production ES256/RS256 verification is disabled.`);
  expect(mode).toBe("local-hs256-test; production-es256-rs256-disabled");
}, 30000);

afterAll(async () => {
  await pool?.end();
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await admin.query("DELETE FROM nyuma_private.jwt_public_keys");
    await admin.query("DELETE FROM nyuma_private.local_test_hmac_keys WHERE kid = 'local-test'");
    await admin.query(
      `INSERT INTO nyuma_private.verifier_config (id, issuer, audience, local_hs256_enabled)
       VALUES (true, $1, $2, false)
       ON CONFLICT (id) DO UPDATE SET local_hs256_enabled = false`,
      [issuer, audience],
    );
    await admin.query("DELETE FROM users WHERE auth_user_id = ANY($1::uuid[])", [[subjectA, subjectB, suspendedSubject]]);
  } finally {
    await admin.end();
  }
});

describe("Stage B database identity", () => {
  it("accepts a valid local HS256 test token and rejects a suspended account id", async () => {
    const token = await sign(subjectA);
    const suspended = await sign(suspendedSubject);
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const active = await withPooledSession(api, token, async (client) => verified(client));
    expect(active).toEqual({ sub: subjectA, accountId: accountA, status: "active" });
    const held = await withPooledSession(api, suspended, async (client) => verified(client));
    expect(held).toEqual({ sub: suspendedSubject, accountId: null, status: "suspended" });
    await expect(withPooledSession(api, null, (client) => client.query("SELECT local_hs256_enabled FROM nyuma_private.verifier_config"))).rejects.toThrow(/permission denied/);
    await expect(withPooledSession(api, null, (client) => client.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true"))).rejects.toThrow(/permission denied/);
    await expect(withPooledSession(api, null, (client) => client.query("SET ROLE nyuma_fn_identity"))).rejects.toThrow(/permission denied/);
    const admin = await connectClient(adminUrl);
    try {
      await expect(admin.query("SET ROLE nyuma_api")).resolves.toBeDefined();
      await expect(admin.query("SELECT secret FROM nyuma_private.local_test_hmac_keys")).rejects.toThrow(/permission denied/);
      await expect(admin.query("SELECT local_hs256_enabled FROM nyuma_private.verifier_config")).rejects.toThrow(/permission denied/);
      await expect(admin.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true")).rejects.toThrow(/permission denied/);
      await admin.query("RESET ROLE");
      const owner = await admin.query<{ owner: string; prosecdef: boolean }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'nyuma_verified_sub'`,
      );
      expect(owner.rows[0]).toEqual({ owner: "nyuma_fn_identity", prosecdef: true });
      const usage = await admin.query<{ usage: boolean }>(
        "SELECT has_schema_privilege('nyuma_api', 'nyuma_private', 'USAGE') AS usage",
      );
      expect(usage.rows[0]?.usage).toBe(false);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.end();
    }
  });

  it("rejects an invalid signature, the wrong issuer, audience, and role claims", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    const [header, payload, signature] = token.split(".");
    const signatureBytes = Buffer.from(signature!, "base64url");
    signatureBytes[0] ^= 0xff;
    const forged = `${header}.${payload}.${signatureBytes.toString("base64url")}`;
    const claims = [
      forged,
      await sign(subjectA, { issuer: "https://other.example/auth/v1" }),
      await sign(subjectA, { audience: "anon" }),
      await sign(subjectA, { extra: { role: "service_role" } }),
      await sign(subjectA, { extra: { role: "anon" } }),
      await sign(subjectA, { extra: { role: undefined } }),
      "not-a-token",
      "a.b",
    ];
    for (const candidate of claims) {
      const result = await withPooledSession(api, candidate, async (client) => verified(client));
      expect(result).toEqual({ sub: null, accountId: null, status: null });
    }
    const unsigned = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subjectA)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(secretKey);
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const noneToken = `${noneHeader}.${unsigned.split(".")[1]}.`;
    const none = await withPooledSession(api, noneToken, async (client) => verified(client));
    expect(none).toEqual({ sub: null, accountId: null, status: null });
  });

  it("rejects a tampered JWT payload", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string };
    decoded.sub = subjectB;
    const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    const result = await withPooledSession(api, tampered, async (client) => verified(client));
    expect(result).toEqual({ sub: null, accountId: null, status: null });
  });

  it("rejects an expired token", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA, { expiresIn: Math.floor(Date.now() / 1000) - 120 });
    const result = await withPooledSession(api, token, async (client) => verified(client));
    expect(result).toEqual({ sub: null, accountId: null, status: null });
  });

  it("returns no identity when the token is missing", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const missing = await withPooledSession(api, null, async (client) => verified(client));
    const blank = await withPooledSession(api, "   ", async (client) => verified(client));
    expect(missing).toEqual({ sub: null, accountId: null, status: null });
    expect(blank).toEqual({ sub: null, accountId: null, status: null });
  });

  it("ignores a forged nyuma.user_id setting", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    const forged = await withPooledSession(api, token, async (client) => {
      await client.query("SELECT set_config('nyuma.user_id', $1, true)", [subjectB]);
      return verified(client);
    });
    expect(forged).toEqual({ sub: subjectA, accountId: accountA, status: "active" });
    const onlySetting = await withPooledSession(api, null, async (client) => {
      await client.query("SELECT set_config('nyuma.user_id', $1, true)", [accountB]);
      return verified(client);
    });
    expect(onlySetting).toEqual({ sub: null, accountId: null, status: null });
  });

  it("does not treat another account's token as this account", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectB);
    const result = await withPooledSession(api, token, async (client) => {
      await client.query("SELECT set_config('nyuma.user_id', $1, true)", [accountA]);
      return verified(client);
    });
    expect(result).toEqual({ sub: subjectB, accountId: accountB, status: "active" });
    expect(result.accountId).not.toBe(accountA);
  });

  it("drops the token when the transaction rolls back", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    await expect(withPooledSession(api, token, async (client) => {
      expect(await verified(client)).toEqual({ sub: subjectA, accountId: accountA, status: "active" });
      throw new Error("rollback this request");
    })).rejects.toThrow(/rollback this request/);
    const after = await withPooledSession(api, null, async (client) => verified(client));
    expect(after).toEqual({ sub: null, accountId: null, status: null });

    const direct = await connectClient(apiUrl);
    try {
      await direct.query("BEGIN");
      await direct.query("SELECT set_config('nyuma.access_token', $1, true)", [token]);
      expect((await verified(direct)).sub).toBe(subjectA);
      await direct.query("ROLLBACK");
      expect(await verified(direct)).toEqual({ sub: null, accountId: null, status: null });
      const setting = await direct.query<{ token: string | null }>("SELECT current_setting('nyuma.access_token', true) AS token");
      const remaining = setting.rows[0]?.token ?? null;
      expect(remaining === null || remaining === "").toBe(true);
      expect(remaining).not.toBe(token);
    } finally {
      await direct.query("ROLLBACK").catch(() => undefined);
      await direct.end();
    }
  });

  it("does not keep an authenticated identity after the connection returns to the pool", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    await withPooledSession(api, token, async (client) => {
      expect((await verified(client)).accountId).toBe(accountA);
      await client.query("SELECT set_config('nyuma.access_token', 'session-leak', false)");
    });
    const reused = await withPooledSession(api, null, async (client) => {
      const setting = await client.query<{ token: string | null }>("SELECT current_setting('nyuma.access_token', true) AS token");
      return { setting: setting.rows[0]?.token ?? null, identity: await verified(client) };
    });
    expect(reused.setting === null || reused.setting === "").toBe(true);
    expect(reused.setting).not.toBe("session-leak");
    expect(reused.identity).toEqual({ sub: null, accountId: null, status: null });
  });

  it("does not authenticate the next request after an unauthenticated checkout", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    expect(await withPooledSession(api, null, async (client) => verified(client))).toEqual({
      sub: null,
      accountId: null,
      status: null,
    });
    expect(await withPooledSession(api, token, async (client) => verified(client))).toEqual({
      sub: subjectA,
      accountId: accountA,
      status: "active",
    });
    expect(await withPooledSession(api, null, async (client) => verified(client))).toEqual({
      sub: null,
      accountId: null,
      status: null,
    });
  });

  it("clears identity after a failed verification", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await sign(subjectA);
    const failed = await withPooledSession(api, "not-a-token", async (client) => verified(client));
    expect(failed).toEqual({ sub: null, accountId: null, status: null });
    const next = await withPooledSession(api, token, async (client) => verified(client));
    expect(next).toEqual({ sub: subjectA, accountId: accountA, status: "active" });
    const cleared = await withPooledSession(api, null, async (client) => verified(client));
    expect(cleared).toEqual({ sub: null, accountId: null, status: null });
  });

  it("fails closed for ES256 even when a public key row exists", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const admin = await connectClient(adminUrl);
    try {
      await admin.query(
        `INSERT INTO nyuma_private.jwt_public_keys (kid, alg, public_jwk)
         VALUES ('local-es256', 'ES256', $1::jsonb)`,
        [JSON.stringify(jwk)],
      );
    } finally {
      await admin.end();
    }
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "local-es256" })
      .setSubject(subjectA)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
    const result = await withPooledSession(api, token, async (client) => verified(client));
    expect(result).toEqual({ sub: null, accountId: null, status: null });
    const cleanup = await connectClient(adminUrl);
    try {
      await cleanup.query("DELETE FROM nyuma_private.jwt_public_keys WHERE kid = 'local-es256'");
    } finally {
      await cleanup.end();
    }
  });

  it("accepts an HS256 token that names its key id", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: "local-test" })
      .setSubject(subjectA)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(secretKey);
    const result = await withPooledSession(api, token, async (client) => verified(client));
    expect(result).toEqual({ sub: subjectA, accountId: accountA, status: "active" });
  });

  it("rejects uppercase and mixed-case HS256 subjects", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const upper = await sign("abcdef00-1234-4000-8000-000000000001".toUpperCase());
    const mixed = await sign("AbCdEf00-1234-4000-8000-000000000001");
    const upperResult = await withPooledSession(api, upper, async (client) => verified(client));
    const mixedResult = await withPooledSession(api, mixed, async (client) => verified(client));
    expect(upperResult).toEqual({ sub: null, accountId: null, status: null });
    expect(mixedResult).toEqual({ sub: null, accountId: null, status: null });
  });

  it("rejects a valid raw bearer while the flag is false and a key exists", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const admin = await connectClient(adminUrl);
    try {
      await admin.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id");
      const token = await sign(subjectA);
      const result = await withPooledSession(api, token, async (client) => verified(client));
      expect(result).toEqual({ sub: null, accountId: null, status: null });
    } finally {
      await admin.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true WHERE id");
      await admin.end();
    }
  });

  it("rejects a valid raw bearer when the configuration row is absent", async () => {
    const api = pool;
    if (!api) throw new Error("nyuma_api pool was not created.");
    const admin = await connectClient(adminUrl);
    try {
      await admin.query("DELETE FROM nyuma_private.verifier_config");
      const token = await sign(subjectA);
      const result = await withPooledSession(api, token, async (client) => verified(client));
      expect(result).toEqual({ sub: null, accountId: null, status: null });
    } finally {
      await admin.query(
        `INSERT INTO nyuma_private.verifier_config (id, issuer, audience, local_hs256_enabled)
         VALUES (true, $1, $2, true)
         ON CONFLICT (id) DO UPDATE
           SET issuer = EXCLUDED.issuer,
               audience = EXCLUDED.audience,
               local_hs256_enabled = true`,
        [issuer, audience],
      );
      await admin.end();
    }
  });
});
