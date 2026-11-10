import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createPostgresIdentityStore, type IdentityStore } from "../src/auth/identity.js";
import { signTestToken, verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { assertApplicationRole, ApplicationRoleError } from "../src/db/applicationRole.js";
import { start } from "../src/index.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const secret = new TextEncoder().encode("local-role-request-secret-not-a-project");
const issuer = "https://example-project.supabase.co/auth/v1";
const check: TokenCheck = { issuer, audience: "authenticated", keys: secret, algorithms: ["HS256"] };
const migrationVersions = [
  "000_roles.sql",
  "001_foundation.sql",
  "002_identity.sql",
  "003_role_assignment_roles.sql",
  "004_role_requests.sql",
  "005_stage_a_roles.sql",
  "006_stage_a_ownership.sql",
  "007_stage_b_identity.sql",
  "008_stage_c_functions.sql",
  "009_stage_d_grants.sql",
  "010_stage_d_search_path.sql",
  "011_assertion_verifier.sql",
  "012_local_hs256_default_off.sql",
  "013_rls_predicates.sql",
];

let adminUrl = "";
let appUrl = "";
let operatorUrl = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Role-request integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  const applied = await applyMigrations(adminUrl);
  const again = await applyMigrations(adminUrl);
  expect(again).toEqual([]);
  console.log(`Role-request migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  const admin = await connectClient(adminUrl);
  try {
    const recorded = await admin.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(recorded.rows.map((row) => row.version)).toEqual(migrationVersions);
    await expect(assertApplicationRole(admin)).rejects.toBeInstanceOf(ApplicationRoleError);
    const appPassword = randomUUID();
    const operatorPassword = randomUUID();
    await admin.query("DROP ROLE IF EXISTS nyuma_it_role_app");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_role_operator");
    await admin.query(`CREATE ROLE nyuma_it_role_app LOGIN PASSWORD '${appPassword}'`);
    await admin.query("GRANT nyuma_app TO nyuma_it_role_app");
    await admin.query(`CREATE ROLE nyuma_it_role_operator LOGIN NOINHERIT PASSWORD '${operatorPassword}'`);
    await admin.query("GRANT nyuma_operator TO nyuma_it_role_operator");
    appUrl = loginUrl(adminUrl, "nyuma_it_role_app", appPassword);
    operatorUrl = loginUrl(adminUrl, "nyuma_it_role_operator", operatorPassword);
    await installLocalHmac(admin, secret, "role-test");
  } finally {
    await admin.end();
  }
}, 30000);

afterAll(async () => {
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await retireLocalHmac(admin, "role-test");
    await admin.query("DROP SCHEMA IF EXISTS nyuma_it_attack CASCADE");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_role_app");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_role_operator");
  } finally {
    await admin.end();
  }
});

describe("PostgreSQL role requests", () => {
  it("applies the same migrations on a clean database", async () => {
    const name = "nyuma_m13_clean";
    await dropDatabase(name);
    const admin = await connectClient(adminUrl);
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const cleanUrl = new URL(adminUrl);
    cleanUrl.pathname = `/${name}`;
    try {
      const applied = await applyMigrations(cleanUrl.toString());
      expect(applied).toEqual(migrationVersions);
      const again = await applyMigrations(cleanUrl.toString());
      expect(again).toEqual([]);
      const client = await connectClient(cleanUrl.toString());
      try {
        const owners = await client.query<{ proname: string; owner: string; prosecdef: boolean }>(
          `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
           ORDER BY p.proname`,
          [[
            "nyuma_approve_role_request",
            "nyuma_list_role_requests",
            "nyuma_reject_role_request",
            "nyuma_revoke_ordinary_role",
            "nyuma_submit_role_requests",
          ]],
        );
        expect(owners.rows).toEqual([
          { proname: "nyuma_approve_role_request", owner: "nyuma_fn_approve", prosecdef: true },
          { proname: "nyuma_list_role_requests", owner: "nyuma_fn_request", prosecdef: true },
          { proname: "nyuma_reject_role_request", owner: "nyuma_fn_reject", prosecdef: true },
          { proname: "nyuma_revoke_ordinary_role", owner: "nyuma_fn_revoke", prosecdef: true },
          { proname: "nyuma_submit_role_requests", owner: "nyuma_fn_request", prosecdef: true },
        ]);
        const roles = await client.query<{ rolname: string; rolsuper: boolean; rolcanlogin: boolean; app: boolean; operator: boolean; provisioner: boolean }>(
          `SELECT rolname, rolsuper, rolcanlogin,
                  pg_has_role(rolname, 'nyuma_app', 'member') AS app,
                  pg_has_role(rolname, 'nyuma_operator', 'member') AS operator,
                  pg_has_role(rolname, 'nyuma_provisioner', 'member') AS provisioner
           FROM pg_roles
           WHERE rolname = ANY($1::text[])
           ORDER BY rolname`,
          [["nyuma_fn_approve", "nyuma_fn_reject", "nyuma_fn_request", "nyuma_fn_revoke", "nyuma_operator"]],
        );
        expect(roles.rows.every((row) => row.rolsuper === false && row.rolcanlogin === false)).toBe(true);
        expect(roles.rows.filter((row) => row.rolname.startsWith("nyuma_fn_")).every((row) => !row.app && !row.operator && !row.provisioner)).toBe(true);
        expect(roles.rows.find((row) => row.rolname === "nyuma_operator")?.provisioner).toBe(false);
      } finally {
        await client.end();
      }
    } finally {
      await dropDatabase(name);
    }
  }, 60000);

  it("lets the application submit and list only its own pending requests", async () => {
    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    const otherApp = await connectClient(appUrl);
    try {
      const first = await createAccount(admin);
      const second = await createAccount(admin);
      await expect(app.query("INSERT INTO role_requests (user_id, role, status) VALUES ($1, 'farmer', 'pending')", [first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer')", [first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("UPDATE user_roles SET role = 'trader' WHERE user_id = $1", [first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("DELETE FROM user_roles WHERE user_id = $1", [first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("SELECT nyuma_approve_role_request($1, NULL)", [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(app.query("SELECT nyuma_reject_role_request($1, NULL)", [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(app.query("SELECT nyuma_revoke_ordinary_role($1, 'farmer')", [first.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("SELECT nyuma_grant_administrator($1)", [first.id])).rejects.toThrow(/permission denied/);
      for (const role of ["nyuma_operator", "nyuma_provisioner", "nyuma_fn_request", "nyuma_fn_approve", "nyuma_fn_reject", "nyuma_fn_revoke"]) {
        await expect(app.query(`SET ROLE ${role}`)).rejects.toThrow(/permission denied/);
      }
      await bindToken(app, secret, first.authUserId);
      await expect(app.query("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [first.authUserId, ["farmer", "administrator"]])).rejects.toThrow(/invalid-request/);
      const written = await admin.query("SELECT count(*) AS n FROM role_requests WHERE user_id = $1", [first.id]);
      expect(Number(written.rows[0]?.n)).toBe(0);

      const [left, right] = await Promise.all([
        submitAs(app, first.authUserId, ["farmer", "farmer", "trader"]),
        submitAs(otherApp, first.authUserId, ["farmer", "trader"]),
      ]);
      expect(left.rows.map((row) => row.status).sort()).toEqual(["pending", "pending"]);
      expect(right.rows.map((row) => row.id).sort()).toEqual(left.rows.map((row) => row.id).sort());
      const grants = await admin.query("SELECT count(*) AS n FROM user_roles WHERE user_id = $1", [first.id]);
      expect(Number(grants.rows[0]?.n)).toBe(0);
      const pending = await admin.query("SELECT count(*) AS n FROM role_requests WHERE user_id = $1 AND status = 'pending'", [first.id]);
      expect(Number(pending.rows[0]?.n)).toBe(2);

      await submitAs(app, second.authUserId, ["buyer"]);
      await bindToken(app, secret, first.authUserId);
      const own = await app.query<{ role: string }>("SELECT role FROM nyuma_list_role_requests($1) ORDER BY role", [first.authUserId]);
      expect(own.rows.map((row) => row.role)).toEqual(["farmer", "trader"]);
      await expect(app.query("SELECT role FROM nyuma_list_role_requests($1)", [second.authUserId])).rejects.toThrow(/invalid-request/);

      const store = createPostgresIdentityStore(appUrl);
      const server = await listen(store);
      try {
        const token = await signTestToken(secret, { subject: first.authUserId, issuer, audience: "authenticated", expiresIn: "10m" });
        const response = await send(addressOf(server), "POST", "/me/role-requests", { authorization: `Bearer ${token}` }, {
          roles: ["farmer"],
          authUserId: second.authUserId,
          userId: second.id,
        });
        const history = await send(addressOf(server), "GET", `/me/role-requests?authUserId=${second.authUserId}&userId=${second.id}`, {
          authorization: `Bearer ${token}`,
        });
        const approve = await send(addressOf(server), "POST", "/me/role-requests/approve", { authorization: `Bearer ${token}` }, { id: left.rows[0]?.id });
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(second.authUserId);
        expect(JSON.stringify(response.body)).not.toContain("buyer");
        expect(JSON.stringify(history.body)).not.toContain("buyer");
        expect(JSON.stringify(history.body)).not.toContain("nyuma_fn_");
        expect(approve.status).toBe(404);
        const secondRows = await admin.query("SELECT role, status FROM role_requests WHERE user_id = $1", [second.id]);
        expect(secondRows.rows).toEqual([{ role: "buyer", status: "pending" }]);
      } finally {
        await close(server);
        await store.close();
      }
    } finally {
      await admin.end();
      await app.end();
      await otherApp.end();
    }
  });

  it("requires SET ROLE and records the function owner rather than the operator login as current_user", async () => {
    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    const operator = await connectClient(operatorUrl);
    try {
      const account = await createAccount(admin);
      await bindToken(app, secret, account.authUserId);
      const submitted = await app.query<{ id: string }>("SELECT id, role FROM nyuma_submit_role_requests($1, $2::text[]) ORDER BY role", [
        account.authUserId,
        ["farmer", "trader"],
      ]);
      const farmerId = submitted.rows[0]?.id;
      const traderId = submitted.rows[1]?.id;
      await expect(operator.query("SELECT nyuma_approve_role_request($1, 'early')", [farmerId])).rejects.toThrow(/permission denied/);
      await expect(operator.query("SELECT nyuma_reject_role_request($1, NULL)", [traderId])).rejects.toThrow(/permission denied/);
      await expect(operator.query("SELECT nyuma_revoke_ordinary_role($1, 'farmer')", [account.id])).rejects.toThrow(/permission denied/);
      const before = await operator.query<{ current_user: string; session_user: string }>("SELECT current_user, session_user");
      expect(before.rows[0]).toEqual({ current_user: "nyuma_it_role_operator", session_user: "nyuma_it_role_operator" });
      await operator.query("SET ROLE nyuma_operator");
      const switched = await operator.query<{ current_user: string; session_user: string }>("SELECT current_user, session_user");
      expect(switched.rows[0]).toEqual({ current_user: "nyuma_operator", session_user: "nyuma_it_role_operator" });

      await expect(operator.query("SELECT nyuma_approve_role_request($1, $2)", [farmerId, "n".repeat(501)])).rejects.toThrow(/invalid-request/);
      const untouched = await admin.query<{ status: string; decided_at: string | null }>("SELECT status, decided_at FROM role_requests WHERE id = $1", [farmerId]);
      expect(untouched.rows[0]).toMatchObject({ status: "pending", decided_at: null });
      expect(await roleCount(admin, account.id, "farmer")).toBe(0);

      await operator.query("SELECT nyuma_approve_role_request($1, 'approved for the account')", [farmerId]);
      const approved = await admin.query<{ status: string; decided_by_role: string; decided_by_login: string; decided_at: Date }>(
        "SELECT status, decided_by_role, decided_by_login, decided_at FROM role_requests WHERE id = $1",
        [farmerId],
      );
      expect(approved.rows[0]?.status).toBe("approved");
      expect(approved.rows[0]?.decided_by_role).toBe("nyuma_fn_approve");
      expect(approved.rows[0]?.decided_by_login).toBe("nyuma_it_role_operator");
      const decidedAt = approved.rows[0]?.decided_at;
      await operator.query("SELECT nyuma_approve_role_request($1, 'again')", [farmerId]);
      const repeated = await admin.query<{ decided_at: Date; decision_note: string }>(
        "SELECT decided_at, decision_note FROM role_requests WHERE id = $1",
        [farmerId],
      );
      expect(repeated.rows[0]?.decided_at).toEqual(decidedAt);
      expect(repeated.rows[0]?.decision_note).toBe("approved for the account");
      expect(await roleCount(admin, account.id, "farmer")).toBe(1);

      await expect(operator.query("SELECT nyuma_reject_role_request($1, 'too late')", [farmerId])).rejects.toThrow(/already decided/);
      const stillApproved = await admin.query<{ status: string; decided_at: Date }>("SELECT status, decided_at FROM role_requests WHERE id = $1", [farmerId]);
      expect(stillApproved.rows[0]?.status).toBe("approved");
      expect(stillApproved.rows[0]?.decided_at).toEqual(decidedAt);

      await operator.query("SELECT nyuma_reject_role_request($1, 'not this time')", [traderId]);
      const rejected = await admin.query<{ status: string; decided_by_role: string; decided_by_login: string }>(
        "SELECT status, decided_by_role, decided_by_login FROM role_requests WHERE id = $1",
        [traderId],
      );
      expect(rejected.rows[0]).toEqual({
        status: "rejected",
        decided_by_role: "nyuma_fn_reject",
        decided_by_login: "nyuma_it_role_operator",
      });
      expect(await roleCount(admin, account.id, "trader")).toBe(0);
      await operator.query("SELECT nyuma_reject_role_request($1, 'again')", [traderId]);
      const rejectNote = await admin.query<{ decision_note: string }>("SELECT decision_note FROM role_requests WHERE id = $1", [traderId]);
      expect(rejectNote.rows[0]?.decision_note).toBe("not this time");
      await expect(operator.query("SELECT nyuma_approve_role_request($1, NULL)", [traderId])).rejects.toThrow(/already decided/);
      expect(await roleCount(admin, account.id, "trader")).toBe(0);

      await bindToken(app, secret, account.authUserId);
      const again = await app.query<{ id: string; status: string }>("SELECT id, status FROM nyuma_submit_role_requests($1, $2::text[])", [
        account.authUserId,
        ["farmer", "trader"],
      ]);
      expect(again.rows.find((row) => row.id === farmerId)?.status).toBe("granted");
      expect(again.rows.some((row) => row.status === "pending" && row.id !== traderId)).toBe(true);
      const traderRows = await admin.query("SELECT count(*) AS n FROM role_requests WHERE user_id = $1 AND role = 'trader'", [account.id]);
      expect(Number(traderRows.rows[0]?.n)).toBe(2);
    } finally {
      await operator.query("RESET ROLE").catch(() => undefined);
      await admin.end();
      await app.end();
      await operator.end();
    }
  });

  it("leaves no role or audit row when approval or revocation fails", async () => {
    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    const operator = await connectClient(operatorUrl);
    try {
      await operator.query("SET ROLE nyuma_operator");
      const suspended = await createAccount(admin);
      await bindToken(app, secret, suspended.authUserId);
      const suspendedRequest = await app.query<{ id: string }>("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        suspended.authUserId,
        ["buyer"],
      ]);
      await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended.id]);
      await expect(operator.query("SELECT nyuma_approve_role_request($1, 'no')", [suspendedRequest.rows[0]?.id])).rejects.toThrow(/not active/);
      const suspendedRow = await admin.query<{ status: string; decided_at: string | null }>(
        "SELECT status, decided_at FROM role_requests WHERE id = $1",
        [suspendedRequest.rows[0]?.id],
      );
      expect(suspendedRow.rows[0]).toMatchObject({ status: "pending", decided_at: null });
      expect(await roleCount(admin, suspended.id, "buyer")).toBe(0);
      expect(await revocationCount(admin, suspended.id)).toBe(0);

      const missing = await createAccount(admin);
      await expect(operator.query("SELECT nyuma_revoke_ordinary_role($1, 'farmer')", [missing.id])).rejects.toThrow(/not granted/);
      expect(await revocationCount(admin, missing.id)).toBe(0);

      const administrator = await createAccount(admin);
      await admin.query("SET ROLE nyuma_provisioner");
      await admin.query("SELECT nyuma_grant_administrator($1)", [administrator.id]);
      await admin.query("RESET ROLE");
      await expect(operator.query("SELECT nyuma_revoke_ordinary_role($1, 'administrator')", [administrator.id])).rejects.toThrow(/administrator/);
      expect(await roleCount(admin, administrator.id, "administrator")).toBe(1);
      expect(await revocationCount(admin, administrator.id)).toBe(0);

      const seller = await createAccount(admin);
      await bindToken(app, secret, seller.authUserId);
      const sellerRequest = await app.query<{ id: string }>("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        seller.authUserId,
        ["farmer"],
      ]);
      await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [sellerRequest.rows[0]?.id]);
      await bindToken(app, secret, seller.authUserId);
      await app.query("SELECT nyuma_set_active_role($1, 'farmer')", [seller.id]);
      const listingId = `m13-list-${randomUUID()}`;
      await admin.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 10, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
        [listingId, seller.id],
      );
      await expect(operator.query("SELECT nyuma_revoke_ordinary_role($1, 'farmer')", [seller.id])).rejects.toThrow(/listing/);
      expect(await roleCount(admin, seller.id, "farmer")).toBe(1);
      expect(await revocationCount(admin, seller.id)).toBe(0);
      const active = await admin.query<{ active_role: string }>("SELECT active_role FROM users WHERE id = $1", [seller.id]);
      expect(active.rows[0]?.active_role).toBe("farmer");

      const buyer = await createAccount(admin);
      await bindToken(app, secret, buyer.authUserId);
      const buyerRequest = await app.query<{ id: string }>("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        buyer.authUserId,
        ["buyer"],
      ]);
      await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [buyerRequest.rows[0]?.id]);
      const demandId = `m13-demand-${randomUUID()}`;
      await admin.query(
        `INSERT INTO buyer_demands (
           id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 10, 'kg', 'Nairobi', 'Today', 40, 'open')`,
        [demandId, buyer.id],
      );
      await expect(operator.query("SELECT nyuma_revoke_ordinary_role($1, 'buyer')", [buyer.id])).rejects.toThrow(/buyer demand/);
      expect(await roleCount(admin, buyer.id, "buyer")).toBe(1);
      expect(await revocationCount(admin, buyer.id)).toBe(0);

      const removable = await createAccount(admin);
      await bindToken(app, secret, removable.authUserId);
      const removableRequest = await app.query<{ id: string }>("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        removable.authUserId,
        ["trader"],
      ]);
      await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [removableRequest.rows[0]?.id]);
      await bindToken(app, secret, removable.authUserId);
      await app.query("SELECT nyuma_set_active_role($1, 'trader')", [removable.id]);
      await operator.query("SELECT nyuma_revoke_ordinary_role($1, 'trader', 'season ended')", [removable.id]);
      expect(await roleCount(admin, removable.id, "trader")).toBe(0);
      const cleared = await admin.query<{ active_role: string | null }>("SELECT active_role FROM users WHERE id = $1", [removable.id]);
      expect(cleared.rows[0]?.active_role).toBeNull();
      const audit = await admin.query<{ revoked_by_role: string; revoked_by_login: string; note: string }>(
        "SELECT revoked_by_role, revoked_by_login, note FROM role_revocations WHERE user_id = $1",
        [removable.id],
      );
      expect(audit.rows).toEqual([{
        revoked_by_role: "nyuma_fn_revoke",
        revoked_by_login: "nyuma_it_role_operator",
        note: "season ended",
      }]);
      const revocationId = (await admin.query<{ id: string }>("SELECT id FROM role_revocations WHERE user_id = $1", [removable.id])).rows[0]?.id;
      await expect(operator.query("UPDATE role_revocations SET note = 'changed' WHERE id = $1", [revocationId])).rejects.toThrow(/permission denied/);
      await expect(operator.query("DELETE FROM role_revocations WHERE id = $1", [revocationId])).rejects.toThrow(/permission denied/);
      await expect(operator.query("INSERT INTO role_revocations (user_id, role, revoked_by_role, revoked_by_login) VALUES ($1, 'trader', 'nyuma_operator', 'forged')", [removable.id])).rejects.toThrow(/permission denied/);
      await expect(app.query("UPDATE role_revocations SET note = 'changed' WHERE id = $1", [revocationId])).rejects.toThrow(/permission denied/);
      await expect(app.query("DELETE FROM role_requests WHERE user_id = $1", [removable.id])).rejects.toThrow(/permission denied/);
      await expect(admin.query("UPDATE role_revocations SET note = 'changed' WHERE id = $1", [revocationId])).rejects.toThrow(/cannot be changed/);
      await expect(admin.query("UPDATE role_requests SET decision_note = 'rewritten' WHERE id = $1", [removableRequest.rows[0]?.id])).rejects.toThrow(/cannot be changed/);
      const preserved = await admin.query<{ note: string }>("SELECT note FROM role_revocations WHERE id = $1", [revocationId]);
      expect(preserved.rows[0]?.note).toBe("season ended");
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await operator.query("RESET ROLE").catch(() => undefined);
      await admin.end();
      await app.end();
      await operator.end();
    }
  });

  it("stops function owners from granting administrator and ignores a substituted search path", async () => {
    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    try {
      const account = await createAccount(admin);
      await admin.query("SET ROLE nyuma_fn_approve");
      await expect(admin.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'administrator')", [account.id])).rejects.toThrow(/administrator/);
      await expect(admin.query("SELECT nyuma_grant_administrator($1)", [account.id])).rejects.toThrow(/permission denied/);
      await admin.query("RESET ROLE");
      await admin.query("SET ROLE nyuma_provisioner");
      await admin.query("SELECT nyuma_grant_administrator($1)", [account.id]);
      await admin.query("RESET ROLE");
      const revokerPassword = randomUUID();
      await admin.query("DROP ROLE IF EXISTS nyuma_it_role_revoker");
      await admin.query(`CREATE ROLE nyuma_it_role_revoker LOGIN NOINHERIT PASSWORD '${revokerPassword}'`);
      await admin.query("GRANT nyuma_fn_revoke TO nyuma_it_role_revoker");
      const revoker = await connectClient(loginUrl(adminUrl, "nyuma_it_role_revoker", revokerPassword));
      try {
        await revoker.query("SET ROLE nyuma_fn_revoke");
        await expect(revoker.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'administrator'", [account.id])).rejects.toThrow(/administrator/);
      } finally {
        await revoker.query("RESET ROLE").catch(() => undefined);
        await revoker.end();
        await admin.query("DROP ROLE IF EXISTS nyuma_it_role_revoker");
      }
      expect(await roleCount(admin, account.id, "administrator")).toBe(1);

      await admin.query("DROP SCHEMA IF EXISTS nyuma_it_attack CASCADE");
      await admin.query("CREATE SCHEMA nyuma_it_attack");
      await admin.query("CREATE TABLE nyuma_it_attack.users (id int)");
      await admin.query("CREATE TABLE nyuma_it_attack.role_requests (id int)");
      await admin.query("GRANT USAGE ON SCHEMA nyuma_it_attack TO nyuma_it_role_app");
      await admin.query("GRANT ALL ON nyuma_it_attack.users, nyuma_it_attack.role_requests TO nyuma_it_role_app");
      await app.query("SET search_path = nyuma_it_attack, public");
      await bindToken(app, secret, account.authUserId);
      const submitted = await app.query<{ id: string; status: string }>(
        "SELECT id, status FROM nyuma_submit_role_requests($1, $2::text[])",
        [account.authUserId, ["farmer"]],
      );
      expect(submitted.rows[0]?.status).toBe("pending");
      const attackUsers = await admin.query("SELECT count(*) AS n FROM nyuma_it_attack.users");
      const attackRequests = await admin.query("SELECT count(*) AS n FROM nyuma_it_attack.role_requests");
      const real = await admin.query("SELECT count(*) AS n FROM public.role_requests WHERE id = $1", [submitted.rows[0]?.id]);
      expect(Number(attackUsers.rows[0]?.n)).toBe(0);
      expect(Number(attackRequests.rows[0]?.n)).toBe(0);
      expect(Number(real.rows[0]?.n)).toBe(1);
      expect(await roleCount(admin, account.id, "farmer")).toBe(0);
      await expect(app.query("CREATE TABLE public.nyuma_it_evil (id int)")).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP SCHEMA IF EXISTS nyuma_it_attack CASCADE").catch(() => undefined);
      await admin.end();
      await app.end();
    }
  });
});

function loginUrl(base: string, username: string, password: string): string {
  const parsed = new URL(base);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

async function createAccount(admin: Client): Promise<{ id: string; authUserId: string }> {
  const authUserId = randomUUID();
  const created = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [authUserId]);
  const id = created.rows[0]?.id;
  if (!id) throw new Error("Account insert did not return an id.");
  return { id, authUserId };
}

async function roleCount(admin: Client, userId: string, role: string): Promise<number> {
  const result = await admin.query("SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND role = $2", [userId, role]);
  return Number(result.rows[0]?.n);
}

async function revocationCount(admin: Client, userId: string): Promise<number> {
  const result = await admin.query("SELECT count(*) AS n FROM role_revocations WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.n);
}

async function dropDatabase(name: string): Promise<void> {
  const admin = await connectClient(adminUrl);
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
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

async function submitAs(client: Client, authUserId: string, roles: string[]) {
  await bindToken(client, secret, authUserId);
  return client.query<{ id: string; status: string }>(
    "SELECT id, status FROM nyuma_submit_role_requests($1, $2::text[])",
    [authUserId, roles],
  );
}

function addressOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a port.");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function send(
  base: string,
  method: string,
  path: string,
  headers: { authorization?: string },
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(`${base}${path}`, {
      method,
      headers: { ...headers, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
