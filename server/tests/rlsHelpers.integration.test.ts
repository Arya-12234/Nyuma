import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { signTestToken } from "../src/auth/tokens.js";
import { mintAssertion } from "../src/assertion/canonical.js";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const helperKey = randomBytes(32);
const helperKid = "h013-helper";
const helperNames = [
  "nyuma_listing_owner_access",
  "nyuma_demand_owner_access",
  "nyuma_commitment_participant",
  "nyuma_purchase_participant",
  "nyuma_outcome_listing_owner",
  "nyuma_outcome_buyer",
];

let admin: pg.Client;
let api: pg.Client;
let accountA = "";
let accountB = "";
let accountC = "";
let suspendedId = "";
let deactivatedId = "";
let traderId = "";
let subjectA = "";
let subjectB = "";
let subjectC = "";
let suspendedSubject = "";
let deactivatedSubject = "";
let traderSubject = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. RLS helper integration was not skipped and was not run.");
  }
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
  const applied = await applyMigrations(config.databaseUrl);
  console.log(`RLS helper migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  admin = await connectClient(config.databaseUrl);
  const cluster = await admin.query<{ db: string; port: number; version: string }>(
    `SELECT current_database() AS db, inet_server_port() AS port, current_setting('server_version') AS version`,
  );
  expect(cluster.rows[0]).toMatchObject({ db: "nyuma_dev", port: 5433, version: "18.4" });
  await removeFixture(admin, []);

  subjectA = randomUUID();
  subjectB = randomUUID();
  subjectC = randomUUID();
  suspendedSubject = randomUUID();
  deactivatedSubject = randomUUID();
  traderSubject = randomUUID();
  const inserted = await admin.query<{ id: string; auth_user_id: string }>(
    `INSERT INTO public.users (auth_user_id) VALUES ($1), ($2), ($3), ($4), ($5), ($6)
     RETURNING id::text AS id, auth_user_id::text AS auth_user_id`,
    [subjectA, subjectB, subjectC, suspendedSubject, deactivatedSubject, traderSubject],
  );
  const idFor = (subject: string) => inserted.rows.find((row) => row.auth_user_id === subject)?.id ?? "";
  accountA = idFor(subjectA);
  accountB = idFor(subjectB);
  accountC = idFor(subjectC);
  suspendedId = idFor(suspendedSubject);
  deactivatedId = idFor(deactivatedSubject);
  traderId = idFor(traderSubject);
  await admin.query("UPDATE public.users SET status = 'suspended' WHERE id = $1", [suspendedId]);
  await admin.query("UPDATE public.users SET status = 'deactivated' WHERE id = $1", [deactivatedId]);
  await admin.query(
    `INSERT INTO public.user_roles (user_id, role) VALUES
       ($1, 'farmer'), ($2, 'buyer'), ($3, 'farmer'), ($4, 'farmer'), ($5, 'farmer'), ($6, 'trader')`,
    [accountA, accountB, accountC, suspendedId, deactivatedId, traderId],
  );
  await admin.query(
    `INSERT INTO public.listings (
       id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location,
       availability_window, asking_price_ksh_per_kg, status
     ) VALUES
       ('h013la', $1, 'Watermelon', 10, 'kg', 'available', 'Kitui', 'Today', 20, 'open'),
       ('h013ls', $2, 'Watermelon', 10, 'kg', 'available', 'Kitui', 'Today', 20, 'open'),
       ('h013lt', $3, 'Watermelon', 10, 'kg', 'available', 'Kitui', 'Today', 20, 'open')`,
    [accountA, suspendedId, traderId],
  );
  await admin.query(
    `INSERT INTO public.buyer_demands (
       id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location,
       collection_window, indicative_price_ksh_per_kg, status
     ) VALUES ('h013db', $1, 'Watermelon', 10, 'kg', 'Kitui', 'Today', 20, 'open')`,
    [accountB],
  );
  await admin.query(
    `INSERT INTO public.commitments (
       id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit,
       agreed_price_ksh_per_kg, expected_fulfilment_date, status
     ) VALUES
       ('h013c', 'h013la', 'h013db', 4, 'kg', 20, CURRENT_DATE, 'confirmed'),
       ('h013ct', 'h013lt', 'h013db', 1, 'kg', 20, CURRENT_DATE, 'confirmed')`,
  );
  await admin.query(
    `INSERT INTO public.purchases (
       id, commitment_id, listing_id, actual_quantity, quantity_unit, actual_price_ksh_per_kg, purchase_date
     ) VALUES ('h013p', 'h013c', 'h013la', 4, 'kg', 20, CURRENT_DATE)`,
  );
  await admin.query(
    `INSERT INTO public.outcomes (
       id, listing_id, commitment_id, purchase_id, category, quantity, quantity_unit, recorded_date, notes
     ) VALUES
       ('h013os', 'h013la', 'h013c', 'h013p', 'sold', 4, 'kg', CURRENT_DATE, 'private-note'),
       ('h013ow', 'h013la', NULL, NULL, 'spoiled', 1, 'kg', CURRENT_DATE, 'owner-note')`,
  );
  await admin.query(
    `INSERT INTO nyuma_private.assertion_keys (kid, secret, state) VALUES ($1, $2, 'active')`,
    [helperKid, helperKey],
  );
  const apiUrl = new URL(config.databaseUrl);
  apiUrl.username = "nyuma_api";
  apiUrl.password = "";
  api = await connectClient(apiUrl.toString());
  const who = await api.query<{ current_user: string; rolsuper: boolean }>(
    `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper`,
  );
  expect(who.rows[0]).toEqual({ current_user: "nyuma_api", rolsuper: false });
}, 30000);

afterAll(async () => {
  if (admin) {
    await removeFixture(admin, [accountA, accountB, accountC, suspendedId, deactivatedId, traderId]).catch(() => undefined);
    await admin.end();
  }
  await api?.end();
});

describe("migration 013 predicate helpers", () => {
  it("owns the six helpers by nyuma_fn_constraint and grants execute only to nyuma_app", async () => {
    const functions = await admin.query<{
      name: string;
      owner: string;
      security_definer: boolean;
      volatility: string;
      config: string[];
      api_execute: boolean;
      app_execute: boolean;
      public_execute: boolean;
      acl: string;
    }>(
      `SELECT p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS security_definer,
              CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable' ELSE 'immutable' END AS volatility,
              p.proconfig AS config,
              has_function_privilege('nyuma_api', p.oid, 'EXECUTE') AS api_execute,
              has_function_privilege('nyuma_app', p.oid, 'EXECUTE') AS app_execute,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
              p.proacl::text AS acl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       ORDER BY p.proname`,
      [helperNames],
    );
    expect(functions.rows).toHaveLength(6);
    for (const row of functions.rows) {
      expect(row.owner).toBe("nyuma_fn_constraint");
      expect(row.security_definer).toBe(true);
      expect(row.volatility).toBe("volatile");
      expect(row.config).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(row.api_execute).toBe(true);
      expect(row.app_execute).toBe(true);
      expect(row.public_execute).toBe(false);
      expect(row.acl).toBe("{nyuma_fn_constraint=X/nyuma_fn_constraint,nyuma_app=X/nyuma_fn_constraint}");
    }
    const membership = await admin.query<{ granted: string }>(
      `SELECT granted.rolname AS granted
       FROM pg_auth_members AS member
       JOIN pg_roles AS login ON login.oid = member.member
       JOIN pg_roles AS granted ON granted.oid = member.roleid
       WHERE login.rolname = 'nyuma_api'
       ORDER BY granted.rolname`,
    );
    expect(membership.rows).toEqual([{ granted: "nyuma_app" }]);
  });

  it("accepts the active listing owner and rejects another account uuid", async () => {
    const row = await predicates(subjectA);
    expect(row).toMatchObject({
      listing_a: true,
      listing_b: false,
      listing_c: false,
      listing_suspended: false,
      listing_random: false,
      demand_a: false,
      demand_b: false,
      commitment: true,
      commitment_missing: false,
      purchase: true,
      purchase_missing: false,
      sold_owner: true,
      spoiled_owner: true,
      sold_buyer: false,
      spoiled_buyer: false,
      outcome_missing: false,
      outcome_owner_missing: false,
      commitment_trader: false,
      verified_sub: subjectA,
      verified_account: accountA,
      account_status: "active",
      own_user_status: "active",
    });
  });

  it("accepts the active buyer for the demand, commitment, purchase, and sold outcome", async () => {
    const row = await predicates(subjectB);
    expect(row).toMatchObject({
      listing_a: false,
      demand_b: true,
      demand_a: false,
      commitment: true,
      commitment_trader: true,
      purchase: true,
      sold_owner: false,
      spoiled_owner: false,
      sold_buyer: true,
      spoiled_buyer: false,
      verified_account: accountB,
      account_status: "active",
    });
  });

  it("rejects an unrelated farmer for the linked records", async () => {
    const row = await predicates(subjectC);
    expect(row).toMatchObject({
      listing_c: true,
      listing_a: false,
      demand_b: false,
      commitment: false,
      purchase: false,
      sold_owner: false,
      sold_buyer: false,
      verified_account: accountC,
    });
  });

  it("returns false from all six helpers for a suspended account that still holds a role", async () => {
    const suspended = await predicates(suspendedSubject);
    expect(suspended).toMatchObject({
      ...closedHelpers,
      verified_sub: suspendedSubject,
      verified_account: null,
      account_status: "suspended",
      own_user_status: "suspended",
    });
  });

  it("returns false from all six helpers for a deactivated account that still holds a role", async () => {
    const deactivated = await predicates(deactivatedSubject);
    expect(deactivated).toMatchObject({
      ...closedHelpers,
      verified_sub: deactivatedSubject,
      verified_account: null,
      account_status: "deactivated",
      own_user_status: "deactivated",
    });
  });

  it("returns false from all six helpers when the transaction has no assertion", async () => {
    const missing = await predicates(null, false);
    expect(missing).toMatchObject({
      ...closedHelpers,
      verified_sub: null,
      verified_account: null,
    });
  });

  it("returns false from all six helpers for an empty, malformed, bad-MAC, expired, or legacy assertion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = mintAssertion({ key: helperKey, kid: helperKid, sub: subjectA, iat: now });
    const expired = mintAssertion({ key: helperKey, kid: helperKid, sub: subjectA, iat: now - 180 });
    const parts = valid.split(".");
    const corrupted = `${parts[0]}.${parts[1]}.${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1) ?? ""}`;
    const hs256 = await signTestToken(new TextEncoder().encode("h013-hs256-secret-32-bytes-long!"), {
      subject: subjectA,
      issuer: "https://example-project.supabase.co/auth/v1",
      audience: "authenticated",
      expiresIn: "10m",
    });
    for (const token of ["", "not-an-assertion", "nya1.abc.def", corrupted, expired, hs256]) {
      const row = await predicates(token, false);
      expect(row).toMatchObject({
        ...closedHelpers,
        verified_sub: null,
        verified_account: null,
      });
    }
  });

  it("returns false for a nonexistent commitment, purchase, and both outcome ids", async () => {
    const row = await predicates(subjectA);
    expect(row).toMatchObject({
      commitment: true,
      purchase: true,
      sold_owner: true,
      sold_buyer: false,
      commitment_missing: false,
      purchase_missing: false,
      outcome_owner_missing: false,
      outcome_missing: false,
    });
  });

  it("accepts a trader for that trader's listing and commitment and rejects buyer checks", async () => {
    const row = await predicates(traderSubject);
    expect(row).toMatchObject({
      listing_trader: true,
      listing_a: false,
      listing_b: false,
      demand_trader: false,
      demand_b: false,
      commitment_trader: true,
      commitment: false,
      purchase: false,
      sold_owner: false,
      spoiled_owner: false,
      sold_buyer: false,
      spoiled_buyer: false,
      verified_account: traderId,
      account_status: "active",
    });
  });

  it("leaves RLS off and keeps verifier secrets away from nyuma_api", async () => {
    const tables = await admin.query<{ name: string; schema: string; rls: boolean; force: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'nyuma_private') AND c.relkind = 'r'
       ORDER BY 1, 2`,
    );
    expect(tables.rows).toHaveLength(16);
    expect(tables.rows.every((row) => row.rls === false && row.force === false)).toBe(true);
    const policies = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname IN ('public', 'nyuma_private')`,
    );
    expect(policies.rows[0]?.count).toBe(0);
    const flag = await admin.query<{ local_hs256_enabled: boolean }>(
      `SELECT local_hs256_enabled FROM nyuma_private.verifier_config WHERE id`,
    );
    expect(flag.rows[0]?.local_hs256_enabled).toBe(false);
    await expect(api.query("SELECT kid FROM nyuma_private.assertion_keys")).rejects.toMatchObject({ code: "42501" });
    await expect(api.query("SELECT local_hs256_enabled FROM nyuma_private.verifier_config")).rejects.toMatchObject({ code: "42501" });
    await expect(api.query("SET ROLE nyuma_fn_constraint")).rejects.toMatchObject({ code: "42501" });
    await expect(api.query("CREATE POLICY denied ON public.users FOR SELECT TO nyuma_app USING (true)")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

async function removeFixture(client: pg.Client, userIds: string[]): Promise<void> {
  const linked = await client.query<{ id: string }>(
    `SELECT owner_id::text AS id FROM public.listings WHERE id IN ('h013la', 'h013ls', 'h013lt')
     UNION
     SELECT buyer_id::text AS id FROM public.buyer_demands WHERE id = 'h013db'`,
  );
  const ids = [...new Set([...userIds, ...linked.rows.map((row) => row.id)].filter((id) => id !== ""))];
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM public.outcomes WHERE id IN ('h013os', 'h013ow')");
    await client.query("DELETE FROM public.purchases WHERE id = 'h013p'");
    await client.query("DELETE FROM public.commitments WHERE id IN ('h013c', 'h013ct')");
    await client.query("DELETE FROM public.listings WHERE id IN ('h013la', 'h013ls', 'h013lt')");
    await client.query("DELETE FROM public.buyer_demands WHERE id = 'h013db'");
    await client.query(
      "DELETE FROM public.coordination_ids WHERE id IN ('h013la', 'h013ls', 'h013lt', 'h013db', 'h013c', 'h013ct', 'h013p', 'h013os', 'h013ow')",
    );
    if (ids.length > 0) {
      await client.query("DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [ids]);
    }
    await client.query("DELETE FROM nyuma_private.assertion_keys WHERE kid = $1", [helperKid]);
    await client.query("COMMIT");
    const replication = await client.query<{ session_replication_role: string }>(
      "SELECT current_setting('session_replication_role') AS session_replication_role",
    );
    if (replication.rows[0]?.session_replication_role !== "origin") {
      throw new Error("session_replication_role remained set after the cleanup transaction.");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const closedHelpers = {
  listing_a: false,
  listing_b: false,
  listing_c: false,
  listing_suspended: false,
  listing_random: false,
  listing_deactivated: false,
  listing_trader: false,
  demand_a: false,
  demand_b: false,
  demand_suspended: false,
  demand_deactivated: false,
  demand_trader: false,
  commitment: false,
  commitment_trader: false,
  commitment_missing: false,
  purchase: false,
  purchase_missing: false,
  sold_owner: false,
  spoiled_owner: false,
  outcome_owner_missing: false,
  sold_buyer: false,
  spoiled_buyer: false,
  outcome_missing: false,
};

async function predicates(token: string | null, mint = true): Promise<Record<string, boolean | string | null>> {
  const wire = mint && token ? mintAssertion({ key: helperKey, kid: helperKid, sub: token, iat: Math.floor(Date.now() / 1000) }) : token;
  await api.query("BEGIN");
  try {
    if (wire !== null) {
      await api.query("SELECT set_config('nyuma.access_token', $1, true)", [wire]);
    }
    const result = await api.query(
      `SELECT public.nyuma_listing_owner_access($1::uuid) AS listing_a,
              public.nyuma_listing_owner_access($2::uuid) AS listing_b,
              public.nyuma_listing_owner_access($3::uuid) AS listing_c,
              public.nyuma_listing_owner_access($4::uuid) AS listing_suspended,
              public.nyuma_listing_owner_access($5::uuid) AS listing_random,
              public.nyuma_listing_owner_access($6::uuid) AS listing_deactivated,
              public.nyuma_listing_owner_access($7::uuid) AS listing_trader,
              public.nyuma_demand_owner_access($1::uuid) AS demand_a,
              public.nyuma_demand_owner_access($2::uuid) AS demand_b,
              public.nyuma_demand_owner_access($4::uuid) AS demand_suspended,
              public.nyuma_demand_owner_access($6::uuid) AS demand_deactivated,
              public.nyuma_demand_owner_access($7::uuid) AS demand_trader,
              public.nyuma_commitment_participant('h013c') AS commitment,
              public.nyuma_commitment_participant('h013ct') AS commitment_trader,
              public.nyuma_commitment_participant('h013missing') AS commitment_missing,
              public.nyuma_purchase_participant('h013p') AS purchase,
              public.nyuma_purchase_participant('h013missing') AS purchase_missing,
              public.nyuma_outcome_listing_owner('h013os') AS sold_owner,
              public.nyuma_outcome_listing_owner('h013ow') AS spoiled_owner,
              public.nyuma_outcome_listing_owner('h013missing') AS outcome_owner_missing,
              public.nyuma_outcome_buyer('h013os') AS sold_buyer,
              public.nyuma_outcome_buyer('h013ow') AS spoiled_buyer,
              public.nyuma_outcome_buyer('h013missing') AS outcome_missing,
              public.nyuma_verified_sub()::text AS verified_sub,
              public.nyuma_verified_account_id()::text AS verified_account,
              public.nyuma_account_status() AS account_status,
              (SELECT users.status FROM public.users AS users WHERE users.auth_user_id = public.nyuma_verified_sub()) AS own_user_status`,
      [accountA, accountB, accountC, suspendedId, randomUUID(), deactivatedId, traderId],
    );
    await api.query("ROLLBACK");
    return result.rows[0] ?? {};
  } catch (error) {
    await api.query("ROLLBACK");
    throw error;
  }
}
