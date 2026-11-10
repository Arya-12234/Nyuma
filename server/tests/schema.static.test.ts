import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transactionalOperations } from "../src/db/operations.js";
import { migrationFiles } from "../src/db/migrate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = path.resolve(root, "server/migrations/001_foundation.sql");
const sql = readFileSync(migrationPath, "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

function tableBody(source: string, name: string): string {
  const match = source.match(new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`));
  if (!match?.[1]) throw new Error(`Missing CREATE TABLE ${name}`);
  return match[1];
}

describe("migration file", () => {
  it("is the first versioned migration and does not seed Nyuma records", async () => {
    const files = await migrationFiles();
    expect(files).toEqual([
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
    ]);
    const executable = stripComments(sql);
    const inserts = [...executable.matchAll(/INSERT INTO ([a-z_]+)/g)].map((match) => match[1]).sort();
    expect(inserts).toEqual(["coordination_ids", "purchases", "user_roles"]);
    expect(executable).toContain("INSERT INTO user_roles (user_id, role) VALUES (p_user_id, 'administrator')");
    expect(executable).not.toMatch(/INSERT INTO user_roles[^;]*'(farmer|trader|buyer)'/);
    expect(sql).not.toContain("nyuma.coordination.v1");
    expect(sql).not.toContain("nyuma.decisionSupport.scenario.v1");
    expect(sql).not.toContain("sample-farmer");
    expect(sql).not.toContain("sample-trader");
    expect(sql).not.toContain("sample-buyer");
    expect(sql).not.toContain("sample-admin");
  });

  it("declares the coordination tables, ownership, and cross-record ids", () => {
    for (const name of ["users", "profiles", "user_roles", "listings", "buyer_demands", "commitments", "purchases", "outcomes", "coordination_ids"]) {
      expect(sql).toContain(`CREATE TABLE ${name}`);
    }
    expect(tableBody(sql, "users")).not.toContain("role");
    expect(tableBody(sql, "user_roles")).toContain("PRIMARY KEY (user_id, role)");
    expect(tableBody(sql, "listings")).toContain("owner_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "buyer_demands")).toContain("buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "commitments")).toContain("listing_id text NOT NULL REFERENCES listings (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "commitments")).toContain("buyer_demand_id text NOT NULL REFERENCES buyer_demands (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "purchases")).toContain("commitment_id text NOT NULL REFERENCES commitments (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "outcomes")).toContain("listing_id text NOT NULL REFERENCES listings (id) ON DELETE RESTRICT");
    expect(tableBody(sql, "outcomes")).toContain("purchase_id text REFERENCES purchases (id) ON DELETE RESTRICT");
  });

  it("restricts every foreign-key delete", () => {
    const executable = stripComments(sql);
    const references = executable.match(/REFERENCES/g) ?? [];
    const restrictions = executable.match(/ON DELETE RESTRICT/g) ?? [];
    expect(references.length).toBeGreaterThan(0);
    expect(restrictions.length).toBe(references.length);
  });

  it("stores gram and cent precision and keeps expected harvest distinct", () => {
    expect(sql.match(/numeric\(14, 3\)/g)?.length).toBe(5);
    expect(sql.match(/numeric\(14, 2\)/g)?.length).toBe(4);
    expect(tableBody(sql, "listings")).toContain("quantity_kind text NOT NULL CHECK (quantity_kind IN ('available', 'expected'))");
    expect(tableBody(sql, "listings")).toContain("CHECK (quantity > 0)");
    expect(tableBody(sql, "commitments")).toContain("CHECK (agreed_price_ksh_per_kg > 0)");
    expect(tableBody(sql, "listings")).toContain("asking_price_ksh_per_kg IS NULL OR asking_price_ksh_per_kg > 0");
  });

  it("limits status and category values to the domain sets", () => {
    expect(tableBody(sql, "listings")).toContain("'draft', 'open', 'closed', 'withdrawn'");
    expect(tableBody(sql, "buyer_demands")).toContain("'open', 'closed', 'withdrawn'");
    expect(tableBody(sql, "buyer_demands")).not.toContain("draft");
    expect(tableBody(sql, "commitments")).toContain("'proposed', 'confirmed', 'fulfilled', 'cancelled'");
    expect(tableBody(sql, "outcomes")).toContain("'sold', 'recovered', 'spoiled', 'donated', 'disposed'");
    expect(tableBody(sql, "user_roles")).toContain("'farmer', 'trader', 'buyer', 'administrator'");
    expect(sql).toContain("A user cannot grant the administrator role.");
    expect(sql).not.toContain("nyuma.allow_admin_grant");
    expect(sql).toContain("pg_has_role(current_user, 'nyuma_provisioner', 'MEMBER')");
    expect(sql).toContain("PERFORM nyuma_lock_user(NEW.owner_id)");
    expect(sql).toContain("PERFORM nyuma_lock_user(NEW.buyer_id)");
    expect(sql).toContain("PERFORM nyuma_lock_user(OLD.user_id)");
  });

  it("prepares row locks and the quantity backstops used by later transactions", () => {
    for (const operation of transactionalOperations) {
      expect(sql).toContain(`FUNCTION ${operation.lockFunction}`);
      expect(operation.locks.length).toBeGreaterThan(0);
    }
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("WHEN c.status IN ('proposed', 'confirmed') THEN nyuma_grams(c.agreed_quantity)::numeric");
    expect(sql).toContain("WHEN c.status = 'fulfilled'");
    expect(sql).toContain("ELSE 0");
    expect(sql).toContain("A cancelled commitment must not hold a purchase.");
    expect(sql).toContain("Purchases would exceed the remaining agreed quantity.");
    expect(sql).toContain("An agreement needs the same produce.");
    expect(sql).toContain("nyuma_is_time_compatible(listing.availability_window, demand.collection_window)");
    expect(sql).toContain("o.purchase_id = p.id AND o.category = 'sold'");
    expect(sql).toContain("outcomes_purchase_is_sold");
    expect(sql).toContain("Record a purchase only against a confirmed commitment.");
  });

  it("creates indexes for owners and the foreign keys used by coordination writes", () => {
    for (const index of [
      "listings_owner_idx",
      "buyer_demands_buyer_idx",
      "commitments_listing_idx",
      "commitments_demand_idx",
      "purchases_commitment_idx",
      "purchases_listing_idx",
      "outcomes_listing_idx",
      "outcomes_purchase_idx",
      "user_roles_role_idx",
    ]) {
      expect(sql).toContain(`CREATE INDEX ${index}`);
    }
  });

  it("keeps identity linking and workspace selection from granting roles", () => {
    const identity = readFileSync(path.resolve(root, "server/migrations/002_identity.sql"), "utf8");
    expect(identity).toContain("REVOKE UPDATE ON users FROM nyuma_app");
    expect(identity).toContain("REVOKE TRUNCATE");
    expect(identity).toContain("The linked identity cannot be changed.");
    expect(identity).toContain("That workspace is not assigned to this account.");
    expect(identity).not.toContain("INSERT INTO user_roles");
    expect(identity).not.toContain("password");
    expect(identity).not.toContain("nyuma.allow_admin_grant");
    expect(identity).not.toContain("sample-farmer");
  });

  it("keeps role requests off direct application writes and separates function owners", () => {
    const roles = readFileSync(path.resolve(root, "server/migrations/003_role_assignment_roles.sql"), "utf8");
    const requests = readFileSync(path.resolve(root, "server/migrations/004_role_requests.sql"), "utf8");
    expect(roles).toContain("-- nyuma:no-transaction");
    for (const name of ["nyuma_operator", "nyuma_fn_request", "nyuma_fn_approve", "nyuma_fn_reject", "nyuma_fn_revoke"]) {
      expect(roles).toContain(`CREATE ROLE ${name} NOLOGIN NOINHERIT`);
    }
    expect(roles).not.toContain("PASSWORD");
    expect(roles).not.toContain("LOGIN PASSWORD");
    expect(requests).toContain("REVOKE INSERT, UPDATE, DELETE ON user_roles FROM nyuma_app");
    expect(requests).toContain("SECURITY DEFINER");
    expect(requests).toContain("SET search_path = pg_catalog, public");
    expect(requests).toContain("pg_has_role(session_user, 'nyuma_operator', 'MEMBER')");
    expect(requests).toContain("NEW.decided_by_role := current_user");
    expect(requests).toContain("NEW.decided_by_login := session_user");
    expect(requests).toContain("NEW.revoked_by_role := current_user");
    expect(requests).toContain("A revocation record cannot be changed.");
    expect(requests).toContain("A role decision cannot be changed.");
    expect(requests).not.toContain("nyuma_grant_administrator");
    expect(requests).not.toContain("GRANT nyuma_provisioner");
    expect(requests).not.toContain("password");
    expect(requests).not.toContain("sample-farmer");
    const submit = functionBody(requests, "nyuma_submit_role_requests");
    const approve = functionBody(requests, "nyuma_approve_role_request");
    const reject = functionBody(requests, "nyuma_reject_role_request");
    const revoke = functionBody(requests, "nyuma_revoke_ordinary_role");
    expect(submit).not.toContain("INSERT INTO public.user_roles");
    expect(submit).not.toContain("UPDATE public.role_requests");
    expect(submit).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    expect(approve).toContain("INSERT INTO public.user_roles");
    expect(approve).not.toMatch(/INSERT INTO public\.user_roles[^;]*administrator/);
    expect(approve).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    expect(reject).not.toContain("user_roles");
    expect(reject).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    const deletion = revoke.indexOf("DELETE FROM public.user_roles");
    const audit = revoke.indexOf("INSERT INTO public.role_revocations");
    expect(deletion).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(deletion);
    expect(revoke).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    for (const body of [submit, approve, reject, revoke, functionBody(requests, "nyuma_list_role_requests")]) {
      expect(body).not.toMatch(/\bEXECUTE\b/);
    }
  });

  it("separates Stage A roles without enabling RLS or storing a password", () => {
    const roles = readFileSync(path.resolve(root, "server/migrations/005_stage_a_roles.sql"), "utf8");
    const ownership = readFileSync(path.resolve(root, "server/migrations/006_stage_a_ownership.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/005_stage_a_rollback.sql"), "utf8");
    expect(roles).toContain("-- nyuma:no-transaction");
    expect(roles).toContain("CREATE ROLE nyuma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");
    expect(roles).toContain("CREATE ROLE nyuma_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION");
    expect(roles).toContain("CREATE ROLE nyuma_fn_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");
    expect(roles).toContain("CREATE ROLE nyuma_fn_constraint NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION");
    expect(roles).toContain("GRANT nyuma_app TO nyuma_api");
    expect(roles).not.toContain("GRANT nyuma_app TO nyuma_owner");
    expect(roles).not.toContain("GRANT nyuma_fn_constraint TO nyuma_api");
    expect(stripComments(roles)).not.toMatch(/PASSWORD/i);
    expect(ownership).toContain("OWNER TO nyuma_owner");
    expect(ownership).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY|REVOKE /);
    expect(ownership).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(ownership).not.toContain("nyuma.coordination.v1");
    expect(ownership).not.toContain("sample-farmer");
    expect(rollback).toContain("Restoring superuser ownership is not the Stage A rollback.");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY|OWNER TO postgres|OWNER TO nyuma[^_]/);
  });

  it("adds Stage B token verification without enabling RLS or a production secret", () => {
    const identity = readFileSync(path.resolve(root, "server/migrations/007_stage_b_identity.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/007_stage_b_rollback.sql"), "utf8");
    const executable = stripComments(identity);
    expect(identity).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA nyuma_private");
    expect(identity).toContain("production-es256-rs256-disabled");
    expect(identity).toContain("current_setting('nyuma.access_token', true)");
    expect(executable).not.toContain("current_setting('nyuma.user_id'");
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(executable).not.toMatch(/PASSWORD/i);
    expect(identity).not.toContain("nyuma.coordination.v1");
    expect(identity).not.toContain("sample-farmer");
    expect(rollback).toContain("DROP SCHEMA IF EXISTS nyuma_private CASCADE");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY|DROP TABLE (users|listings|commitments|purchases|outcomes)/);
  });

  it("secures Stage C functions without enabling RLS", () => {
    const functions = readFileSync(path.resolve(root, "server/migrations/008_stage_c_functions.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/008_stage_c_rollback.sql"), "utf8");
    const executable = stripComments(functions);
    expect(executable).toContain("public.nyuma_verified_account_id()");
    expect(executable).toContain("public.nyuma_verified_sub()");
    expect(executable).toContain("public.nyuma_account_status()");
    expect(executable).toContain("SECURITY DEFINER");
    expect(executable).toContain("OWNER TO nyuma_fn_constraint");
    expect(executable).not.toContain("GRANT nyuma_fn_constraint TO nyuma_api");
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(functions).not.toContain("sample-farmer");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '008_stage_c_functions.sql'");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY|DROP TABLE (users|listings|commitments|purchases|outcomes)/);
  });

  it("revokes Stage D direct writes without enabling RLS", () => {
    const grants = readFileSync(path.resolve(root, "server/migrations/009_stage_d_grants.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/009_stage_d_rollback.sql"), "utf8");
    const executable = stripComments(grants);
    expect(executable).toContain("public.nyuma_insert_commitment");
    expect(executable).toContain("public.nyuma_insert_outcome");
    expect(executable).toContain("REVOKE INSERT, DELETE ON public.commitments FROM nyuma_app");
    expect(executable).toContain("REVOKE INSERT, UPDATE, DELETE ON public.purchases FROM nyuma_app");
    expect(executable).not.toContain("GRANT nyuma_fn_constraint TO nyuma_api");
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(grants).not.toContain("nyuma.coordination.v1");
    expect(grants).not.toContain("sample-farmer");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '009_stage_d_grants.sql'");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY|DROP TABLE (users|listings|commitments|purchases|outcomes)/);
  });

  it("pins privileged search paths so temporary objects cannot shadow them", () => {
    const searchPath = readFileSync(path.resolve(root, "server/migrations/010_stage_d_search_path.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/010_stage_d_search_path_rollback.sql"), "utf8");
    const executable = stripComments(searchPath);
    expect(executable).toContain("pg_catalog, public, pg_temp");
    expect(executable).toContain("FROM public.listings");
    expect(executable).toContain("FROM public.commitments");
    expect(executable).not.toContain("GRANT nyuma_fn_constraint TO nyuma_api");
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(searchPath).not.toContain("sample-farmer");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '010_stage_d_search_path.sql'");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY|DROP TABLE (users|listings|commitments|purchases|outcomes)/);
  });

  it("adds assertion key storage without a key, an API grant, or RLS", () => {
    const sql = readFileSync(path.resolve(root, "server/migrations/011_assertion_verifier.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/011_assertion_verifier_rollback.sql"), "utf8");
    const executable = stripComments(sql);
    expect(executable).toContain("CREATE TABLE nyuma_private.assertion_keys");
    expect(executable).toContain("REVOKE ALL ON TABLE nyuma_private.assertion_keys FROM PUBLIC, nyuma_api, nyuma_app");
    expect(executable).not.toMatch(/INSERT INTO nyuma_private\.assertion_keys/i);
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(executable).toContain("nyuma_private.hmac");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '011_assertion_verifier.sql'");
    expect(rollback).toContain("DROP TABLE IF EXISTS nyuma_private.assertion_keys");
    expect(rollback).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it("keeps local HS256 off unless the database flag is set", () => {
    const sql = readFileSync(path.resolve(root, "server/migrations/012_local_hs256_default_off.sql"), "utf8");
    const rollback = readFileSync(path.resolve(root, "server/migrations/rollback/012_local_hs256_default_off_rollback.sql"), "utf8");
    const executable = stripComments(sql);
    expect(executable).toContain("ADD COLUMN local_hs256_enabled boolean NOT NULL DEFAULT false");
    expect(executable).toContain("INSERT INTO nyuma_private.verifier_config");
    expect(executable).toContain("local_hs256_enabled = false");
    expect(executable).toContain("REVOKE ALL ON TABLE nyuma_private.verifier_config FROM PUBLIC, nyuma_api, nyuma_app");
    expect(executable).toContain("IF v_hs256_enabled IS NOT TRUE THEN");
    expect(executable).toContain("WHERE keys.kid = v_key_id");
    expect(executable).toContain("v_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'");
    expect(executable).not.toMatch(/!~\*/);
    expect(executable).not.toMatch(/INSERT INTO nyuma_private\.assertion_keys|INSERT INTO nyuma_private\.local_test_hmac_keys/);
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '012_local_hs256_default_off.sql'");
    expect(rollback).toContain("DROP COLUMN IF EXISTS local_hs256_enabled");
    expect(rollback).not.toMatch(/DROP TABLE|assertion_keys|ENABLE ROW LEVEL SECURITY/);
  });

  it("orders rollback guards by numeric migration prefix", () => {
    const rollbackDirectory = path.resolve(root, "server/migrations/rollback");
    const targets = new Map<string, number>([
      ["005_stage_a_rollback.sql", 6],
      ["007_stage_b_rollback.sql", 7],
      ["008_stage_c_rollback.sql", 8],
      ["009_stage_d_rollback.sql", 9],
      ["010_stage_d_search_path_rollback.sql", 10],
      ["011_assertion_verifier_rollback.sql", 11],
      ["012_local_hs256_default_off_rollback.sql", 12],
      ["013_rls_predicates_rollback.sql", 13],
    ]);
    for (const [fileName, target] of targets) {
      const source = readFileSync(path.resolve(rollbackDirectory, fileName), "utf8");
      const executable = stripComments(source);
      expect(executable).toContain("v_migration_prefix := substring(v_migration_version FROM '^([0-9]+)')::numeric;");
      expect(executable).toContain("v_migration_prefix::integer > v_migration_target");
      expect(executable).toContain("Unparseable migration version");
      expect(executable).toContain(`v_migration_target constant integer := ${target};`);
      expect(executable).not.toMatch(/version\s*>\s*'/);
    }
    const stageA = readFileSync(path.resolve(rollbackDirectory, "005_stage_a_rollback.sql"), "utf8");
    const assertion = readFileSync(path.resolve(rollbackDirectory, "011_assertion_verifier_rollback.sql"), "utf8");
    const hs256 = readFileSync(path.resolve(rollbackDirectory, "012_local_hs256_default_off_rollback.sql"), "utf8");
    expect(stageA).toContain("Ownership already belongs to nyuma_owner.");
    expect(assertion).toContain("011_assertion_verifier.sql is not recorded. Refusing to roll back.");
    expect(hs256).toContain("012_local_hs256_default_off.sql is not recorded. Refusing to roll back.");
    const predicates = readFileSync(path.resolve(rollbackDirectory, "013_rls_predicates_rollback.sql"), "utf8");
    expect(predicates).toContain("013_rls_predicates.sql is not recorded. Refusing to roll back.");
    expect(stripComments(predicates)).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY|DROP TABLE/);
  });

  it("drops only the six migration 013 helpers, dependents first, and deletes only that migration row", () => {
    const source = readFileSync(path.resolve(root, "server/migrations/rollback/013_rls_predicates_rollback.sql"), "utf8");
    const executable = stripComments(source);
    const drops = [...executable.matchAll(/DROP FUNCTION IF EXISTS public\.[a-z0-9_]+\([^)]+\)/g)].map((match) => match[0]);
    expect(drops).toEqual([
      "DROP FUNCTION IF EXISTS public.nyuma_purchase_participant(text)",
      "DROP FUNCTION IF EXISTS public.nyuma_outcome_listing_owner(text)",
      "DROP FUNCTION IF EXISTS public.nyuma_outcome_buyer(text)",
      "DROP FUNCTION IF EXISTS public.nyuma_commitment_participant(text)",
      "DROP FUNCTION IF EXISTS public.nyuma_listing_owner_access(uuid)",
      "DROP FUNCTION IF EXISTS public.nyuma_demand_owner_access(uuid)",
    ]);
    expect(executable.match(/DROP FUNCTION/g)).toHaveLength(6);
    expect(executable.match(/\bDROP\b/g)).toHaveLength(6);
    expect(drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_purchase_participant(text)")).toBeLessThan(
      drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_commitment_participant(text)"),
    );
    expect(drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_outcome_listing_owner(text)")).toBeLessThan(
      drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_listing_owner_access(uuid)"),
    );
    expect(drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_outcome_buyer(text)")).toBeLessThan(
      drops.indexOf("DROP FUNCTION IF EXISTS public.nyuma_demand_owner_access(uuid)"),
    );
    expect(executable).not.toMatch(/\bCASCADE\b/);
    expect(executable).not.toMatch(/DROP TABLE|DROP POLICY|DROP VIEW|DROP SCHEMA|DROP ROLE/);
    const deletes = [...executable.matchAll(/DELETE FROM [^;]+/g)].map((match) => match[0].replace(/\s+/g, " ").trim());
    expect(deletes).toEqual(["DELETE FROM schema_migrations WHERE version = '013_rls_predicates.sql'"]);
    expect(executable).toContain("v_migration_target constant integer := 13;");
    expect(executable).toContain("v_migration_prefix := substring(v_migration_version FROM '^([0-9]+)')::numeric;");
    expect(executable).toContain("v_migration_prefix::integer > v_migration_target");
    expect(executable).toContain("Unparseable migration version");
    expect(executable).toContain("013_rls_predicates.sql is not recorded. Refusing to roll back.");
    expect(executable).toContain("A later migration is recorded. Do not roll this change back with this script.");
    expect(executable).not.toMatch(/version\s*>\s*'/);
  });

  it("adds only the six approved predicate helpers in migration 013", () => {
    const sql = readFileSync(path.resolve(root, "server/migrations/013_rls_predicates.sql"), "utf8");
    const executable = stripComments(sql);
    for (const name of [
      "nyuma_listing_owner_access",
      "nyuma_demand_owner_access",
      "nyuma_commitment_participant",
      "nyuma_purchase_participant",
      "nyuma_outcome_listing_owner",
      "nyuma_outcome_buyer",
    ]) {
      expect(executable).toContain(`CREATE FUNCTION public.${name}`);
      expect(executable).toContain(`ALTER FUNCTION public.${name}`);
      expect(executable).toContain("OWNER TO nyuma_fn_constraint");
    }
    expect(executable.match(/CREATE FUNCTION/g)).toHaveLength(6);
    expect(executable).toContain("roles.user_id = public.nyuma_verified_account_id()");
    expect(executable).toContain("AND roles.user_id = p_owner_id");
    expect(executable).toContain("AND roles.user_id = p_buyer_id");
    expect(executable).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY|USING \(true\)/);
    expect(executable).not.toMatch(/GRANT (?!EXECUTE)|ALTER TABLE|CREATE ROLE|INSERT INTO/);
  });

  it("requires the same authenticated role claim in the API and the database", () => {
    const api = readFileSync(path.resolve(root, "server/src/auth/tokens.ts"), "utf8");
    const identity = readFileSync(path.resolve(root, "server/migrations/007_stage_b_identity.sql"), "utf8");
    expect(api).toContain('payload.role !== "authenticated"');
    expect(identity).toContain("payload->>'role' IS DISTINCT FROM 'authenticated'");
  });
});

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`FUNCTION public.${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("$fn$", start);
  const bodyEnd = source.indexOf("$fn$;", bodyStart + 4);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error(`Missing body for ${name}`);
  return source.slice(bodyStart, bodyEnd);
}
