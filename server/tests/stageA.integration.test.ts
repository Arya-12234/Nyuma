import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { assertApplicationRole, ApplicationRoleError } from "../src/db/applicationRole.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { applicationReadiness } from "../src/db/ready.js";

const databaseUrl = process.env.DATABASE_URL;
const blockedRoles = [
  "nyuma_owner",
  "nyuma_provisioner",
  "nyuma_operator",
  "nyuma_fn_identity",
  "nyuma_fn_constraint",
  "nyuma_fn_request",
  "nyuma_fn_approve",
  "nyuma_fn_reject",
  "nyuma_fn_revoke",
];

let adminUrl = "";
let apiUrl = "";
let ownerUrl = "";

function loginUrl(admin: string, username: string): string {
  const parsed = new URL(admin);
  parsed.username = username;
  parsed.password = "";
  return parsed.toString();
}

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Stage A integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  const applied = await applyMigrations(adminUrl);
  const again = await applyMigrations(adminUrl);
  expect(again).toEqual([]);
  console.log(`Stage A migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  apiUrl = loginUrl(adminUrl, "nyuma_api");
  ownerUrl = loginUrl(adminUrl, "nyuma_owner");
}, 30000);

describe("Stage A role separation", () => {
  it("records the role attributes, memberships, and dormant bypass flag", async () => {
    const admin = await connectClient(adminUrl);
    try {
      const attributes = await admin.query<{
        rolname: string;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
      }>(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication
         FROM pg_roles
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname`,
        [["nyuma_owner", "nyuma_api", "nyuma_fn_identity", "nyuma_fn_constraint"]],
      );
      expect(attributes.rows).toEqual([
        {
          rolname: "nyuma_api",
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
          rolinherit: true,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        },
        {
          rolname: "nyuma_fn_constraint",
          rolcanlogin: false,
          rolsuper: false,
          rolbypassrls: true,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        },
        {
          rolname: "nyuma_fn_identity",
          rolcanlogin: false,
          rolsuper: false,
          rolbypassrls: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        },
        {
          rolname: "nyuma_owner",
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        },
      ]);

      const bypass = await admin.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname",
      );
      expect(bypass.rows.map((row) => row.rolname)).toEqual(["nyuma_fn_constraint"]);

      const passwords = await admin.query<{ rolname: string }>(
        `SELECT rolname FROM pg_authid
         WHERE rolname = ANY($1::text[]) AND rolpassword IS NOT NULL
         ORDER BY rolname`,
        [["nyuma_owner", "nyuma_api", "nyuma_fn_identity", "nyuma_fn_constraint"]],
      );
      expect(passwords.rows).toEqual([]);

      const apiMembers = await admin.query<{ rolname: string }>(
        `SELECT granted.rolname
         FROM pg_auth_members membership
         JOIN pg_roles granted ON granted.oid = membership.roleid
         JOIN pg_roles member ON member.oid = membership.member
         WHERE member.rolname = 'nyuma_api'
         ORDER BY granted.rolname`,
      );
      expect(apiMembers.rows.map((row) => row.rolname)).toEqual(["nyuma_app"]);

      const ownerMembers = await admin.query<{ rolname: string }>(
        `SELECT granted.rolname
         FROM pg_auth_members membership
         JOIN pg_roles granted ON granted.oid = membership.roleid
         JOIN pg_roles member ON member.oid = membership.member
         WHERE member.rolname = 'nyuma_owner'
         ORDER BY granted.rolname`,
      );
      expect(ownerMembers.rows.map((row) => row.rolname)).toEqual([
        "nyuma_fn_approve",
        "nyuma_fn_constraint",
        "nyuma_fn_identity",
        "nyuma_fn_reject",
        "nyuma_fn_request",
        "nyuma_fn_revoke",
        "nyuma_operator",
        "nyuma_provisioner",
      ]);
      expect(await admin.query("SELECT pg_has_role('nyuma_owner', 'nyuma_app', 'member') AS member")).toMatchObject({
        rows: [{ member: false }],
      });
    } finally {
      await admin.end();
    }
  });

  it("moves public objects off superusers and leaves RLS disabled", async () => {
    const admin = await connectClient(adminUrl);
    try {
      const superuserTables = await admin.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles owner_role ON owner_role.oid = c.relowner
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i')
           AND owner_role.rolsuper
         ORDER BY c.relname`,
      );
      expect(superuserTables.rows).toEqual([]);

      const superuserFunctions = await admin.query<{ signature: string }>(
        `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles owner_role ON owner_role.oid = p.proowner
         WHERE n.nspname = 'public' AND owner_role.rolsuper
         ORDER BY signature`,
      );
      expect(superuserFunctions.rows).toEqual([]);

      const definers = await admin.query<{ proname: string; owner: string; prosecdef: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY($1::text[])
         ORDER BY p.proname`,
        [["nyuma_set_commitment_status", "nyuma_insert_purchase", "nyuma_set_active_role", "nyuma_submit_role_requests", "nyuma_approve_role_request"]],
      );
      expect(definers.rows).toEqual([
        { proname: "nyuma_approve_role_request", owner: "nyuma_fn_approve", prosecdef: true },
        { proname: "nyuma_insert_purchase", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_set_active_role", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_set_commitment_status", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_submit_role_requests", owner: "nyuma_fn_request", prosecdef: true },
      ]);

      const security = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY c.relname`,
      );
      expect(security.rows.length).toBeGreaterThan(0);
      expect(security.rows.every((row) => row.relrowsecurity === false && row.relforcerowsecurity === false)).toBe(true);
      const policies = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_policies WHERE schemaname = 'public'");
      expect(policies.rows[0]?.count).toBe("0");

      const privileges = await admin.query<{ listing_select: boolean; commitment_update: boolean; create_schema: boolean }>(
        `SELECT has_table_privilege('nyuma_app', 'listings', 'SELECT') AS listing_select,
                has_table_privilege('nyuma_app', 'commitments', 'UPDATE') AS commitment_update,
                has_schema_privilege('nyuma_api', 'public', 'CREATE') AS create_schema`,
      );
      expect(privileges.rows[0]).toEqual({ listing_select: true, commitment_update: false, create_schema: false });
      const ownerSchema = await admin.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege('nyuma_owner', 'public', 'USAGE') AS usage,
                has_schema_privilege('nyuma_owner', 'public', 'CREATE') AS create`,
      );
      expect(ownerSchema.rows[0]).toEqual({ usage: true, create: true });
    } finally {
      await admin.end();
    }
  });

  it("lets nyuma_api read a listing and blocks role escalation", async () => {
    const api = await connectClient(apiUrl);
    try {
      expect(await applicationReadiness(apiUrl)).toBe("ready");
      await assertApplicationRole(api);
      const who = await api.query<{ current_user: string; rolsuper: boolean }>(
        `SELECT current_user, rolsuper
         FROM pg_roles
         WHERE rolname = current_user`,
      );
      expect(who.rows[0]).toEqual({ current_user: "nyuma_api", rolsuper: false });
      await api.query("SELECT id FROM listings LIMIT 1");
      for (const role of blockedRoles) {
        await expect(api.query(`SET ROLE ${role}`)).rejects.toThrow(/permission denied/);
        const still = await api.query<{ current_user: string }>("SELECT current_user");
        expect(still.rows[0]?.current_user).toBe("nyuma_api");
      }
      await expect(api.query("GRANT nyuma_fn_constraint TO nyuma_api")).rejects.toThrow(/permission denied/);
      await expect(api.query("CREATE ROLE nyuma_api_escalation NOLOGIN")).rejects.toThrow(/permission denied/);
      await api.query("SET ROLE nyuma_app");
      const switched = await api.query<{ current_user: string }>("SELECT current_user");
      expect(switched.rows[0]?.current_user).toBe("nyuma_app");
    } finally {
      await api.query("RESET ROLE").catch(() => undefined);
      await api.end();
    }
  });

  it("rejects nyuma_owner as an API session while the constraint role can read rows it checks", async () => {
    const owner = await connectClient(ownerUrl);
    try {
      expect(await applicationReadiness(ownerUrl)).toBe("unavailable");
      await expect(assertApplicationRole(owner)).rejects.toBeInstanceOf(ApplicationRoleError);
      await owner.query("SELECT count(*) FROM listings");
      await owner.query("SET ROLE nyuma_fn_constraint");
      const switched = await owner.query<{ current_user: string; rolbypassrls: boolean }>(
        `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(switched.rows[0]).toEqual({ current_user: "nyuma_fn_constraint", rolbypassrls: true });
      const visible = await owner.query<{ count: string }>("SELECT count(*) FROM listings");
      expect(Number(visible.rows[0]?.count)).toBeGreaterThanOrEqual(0);
      await expect(owner.query("SET ROLE nyuma_api")).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query("RESET ROLE").catch(() => undefined);
      await owner.end();
    }
  });
});

describe("Stage A connection types", () => {
  it("uses distinct login URLs", () => {
    expect(apiUrl).toContain("nyuma_api");
    expect(ownerUrl).toContain("nyuma_owner");
    expect(apiUrl).not.toContain("nyuma_owner");
  });
});
