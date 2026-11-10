import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountDisabled, createPostgresIdentityStore, type IdentityStore } from "../src/auth/identity.js";
import { signTestToken, verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { assertApplicationRole, ApplicationRoleError } from "../src/db/applicationRole.js";
import { applicationReadiness } from "../src/db/ready.js";
import { connectClient } from "../src/db/client.js";
import { bindRequestToken } from "../src/db/session.js";
import { applyMigrations } from "../src/db/migrate.js";
import { start } from "../src/index.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const secret = new TextEncoder().encode("local-identity-test-secret-not-a-project");
const issuer = "https://example-project.supabase.co/auth/v1";
const check: TokenCheck = { issuer, audience: "authenticated", keys: secret, algorithms: ["HS256"] };

let adminUrl = "";
let appUrl = "";
let store: IdentityStore | null = null;

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Identity integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    await expect(assertApplicationRole(admin)).rejects.toBeInstanceOf(ApplicationRoleError);
    expect(await applicationReadiness(adminUrl)).toBe("unavailable");
    const password = randomUUID();
    await admin.query("DROP ROLE IF EXISTS nyuma_it_identity");
    await admin.query(`CREATE ROLE nyuma_it_identity LOGIN PASSWORD '${password}'`);
    await admin.query("GRANT nyuma_app TO nyuma_it_identity");
    const parsed = new URL(adminUrl);
    parsed.username = "nyuma_it_identity";
    parsed.password = password;
    appUrl = parsed.toString();
    await installLocalHmac(admin, secret, "identity-test");
  } finally {
    await admin.end();
  }
    expect(await applicationReadiness(appUrl)).toBe("ready");
    store = createPostgresIdentityStore(appUrl);
}, 30000);

afterAll(async () => {
  if (store) await store.close();
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await retireLocalHmac(admin, "identity-test");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_identity");
  } finally {
    await admin.end();
  }
});

describe("PostgreSQL identity, not a live Supabase project", () => {
  it("bootstraps one account per verified identity and refuses to move that link", async () => {
    const authUserId = randomUUID();
    const otherAuthUserId = randomUUID();
    const token = await signTestToken(secret, { subject: authUserId, issuer, audience: "authenticated", expiresIn: "10m" });
    const verified = await verifyAccessToken(token, check);
    const identities = requireStore();
    const [first, second] = await Promise.all([
      bindRequestToken(token, () => identities.bootstrap(verified.authUserId)),
      bindRequestToken(token, () => identities.bootstrap(verified.authUserId)),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.roles).toEqual([]);
    expect(first.status).toBe("active");

    const server = await listen(identities);
    try {
      const response = await send(addressOf(server), "POST", "/me/bootstrap", { authorization: `Bearer ${token}` }, {
        userId: first.id,
        authUserId: otherAuthUserId,
        role: "administrator",
      });
      expect(response.status).toBe(200);
      expect((response.body as { account: { id: string; roles: string[] } }).account.id).toBe(first.id);
      expect((response.body as { account: { roles: string[] } }).account.roles).toEqual([]);
    } finally {
      await close(server);
    }

    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    try {
      const count = await admin.query("SELECT count(*) AS n FROM users WHERE auth_user_id = $1", [authUserId]);
      expect(Number(count.rows[0]?.n)).toBe(1);
      const created = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [otherAuthUserId]);
      const otherId = created.rows[0]?.id;
      await expect(admin.query("UPDATE users SET auth_user_id = $1 WHERE id = $2", [authUserId, otherId])).rejects.toThrow(/cannot be changed|unique|duplicate/i);
      await expect(app.query("UPDATE users SET auth_user_id = $1 WHERE id = $2", [authUserId, first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("TRUNCATE users")).rejects.toThrow(/permission denied/);
      await expect(app.query("SET ROLE nyuma_provisioner")).rejects.toThrow(/permission denied/);
      const roles = await admin.query("SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND role = 'administrator'", [first.id]);
      expect(Number(roles.rows[0]?.n)).toBe(0);
    } finally {
      await admin.end();
      await app.end();
    }
  });

  it("rejects a disabled account and an unassigned workspace, including administrator", async () => {
    const authUserId = randomUUID();
    const identities = requireStore();
    const token = await signTestToken(secret, { subject: authUserId, issuer, audience: "authenticated", expiresIn: "30m" });
    const account = await bindRequestToken(token, () => identities.bootstrap(authUserId));
    const app = await connectClient(appUrl);
    const admin = await connectClient(adminUrl);
    try {
      await expect(app.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer')", [account.id])).rejects.toThrow(
        /permission denied/,
      );
      await bindToken(app, secret, authUserId);
      await app.query("SELECT nyuma_submit_role_requests($1, $2::text[])", [authUserId, ["farmer", "trader"]]);
      const password = randomUUID();
      await admin.query("DROP ROLE IF EXISTS nyuma_it_identity_operator");
      await admin.query(`CREATE ROLE nyuma_it_identity_operator LOGIN NOINHERIT PASSWORD '${password}'`);
      await admin.query("GRANT nyuma_operator TO nyuma_it_identity_operator");
      const operatorUrl = new URL(adminUrl);
      operatorUrl.username = "nyuma_it_identity_operator";
      operatorUrl.password = password;
      const operator = await connectClient(operatorUrl.toString());
      try {
        await expect(operator.query("SELECT nyuma_approve_role_request($1, NULL)", [randomUUID()])).rejects.toThrow(/permission denied/);
        await operator.query("SET ROLE nyuma_operator");
        const pending = await operator.query<{ id: string }>(
          "SELECT id FROM role_requests WHERE user_id = $1 AND status = 'pending' ORDER BY role",
          [account.id],
        );
        for (const row of pending.rows) {
          await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [row.id]);
        }
      } finally {
        await operator.end();
      }
      const selected = await bindRequestToken(token, () => identities.setActiveRole(authUserId, "farmer"));
      expect(selected.roles).toEqual(["farmer", "trader"]);
      expect(selected.activeRole).toBe("farmer");
      await expect(bindRequestToken(token, () => identities.setActiveRole(authUserId, "buyer"))).rejects.toThrow(/workspace-not-assigned/);
      await expect(bindRequestToken(token, () => identities.setActiveRole(authUserId, "administrator"))).rejects.toThrow(/workspace-not-assigned/);
      const admins = await app.query("SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND role = 'administrator'", [account.id]);
      expect(Number(admins.rows[0]?.n)).toBe(0);
      await expect(app.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'farmer'", [account.id])).rejects.toThrow(
        /permission denied/,
      );
      const revoker = await connectClient(operatorUrl.toString());
      try {
        await revoker.query("SET ROLE nyuma_operator");
        await revoker.query("SELECT nyuma_revoke_ordinary_role($1, 'farmer')", [account.id]);
      } finally {
        await revoker.end();
      }
      await admin.query("DROP ROLE IF EXISTS nyuma_it_identity_operator");
      const cleared = await identities.findAccount(authUserId);
      expect(cleared?.activeRole).toBeNull();
      expect(cleared?.roles).toEqual(["trader"]);

      await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [account.id]);
      await expect(bindRequestToken(token, () => identities.bootstrap(authUserId))).rejects.toBeInstanceOf(AccountDisabled);
      await expect(app.query("UPDATE users SET status = 'active' WHERE id = $1", [account.id])).rejects.toThrow(/permission denied/);
      const still = await admin.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [account.id]);
      expect(still.rows[0]?.status).toBe("suspended");
    } finally {
      await admin.query("DROP ROLE IF EXISTS nyuma_it_identity_operator").catch(() => undefined);
      await app.end();
      await admin.end();
    }
  });
});

function requireStore(): IdentityStore {
  if (!store) throw new Error("The identity store was not opened.");
  return store;
}

async function listen(identities: IdentityStore): Promise<Server> {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test",
    SUPABASE_URL: "https://example-project.supabase.co",
    SUPABASE_ANON_KEY: "publishable-test-value",
  });
  return start({ HOST: "127.0.0.1", PORT: "0" }, {
    config,
    identities,
    auth: null,
    verifyToken: (token) => verifyAccessToken(token, check),
  });
}

function addressOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a port.");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function send(base: string, method: string, path: string, headers: { authorization: string }, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(`${base}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
