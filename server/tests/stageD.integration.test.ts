import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const hmacSecret = new TextEncoder().encode("local-stage-d-secret-not-a-project");

let adminUrl = "";
let apiUrl = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Stage D integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    await installLocalHmac(admin, hmacSecret, "stage-d-test");
    const parsed = new URL(adminUrl);
    parsed.username = "nyuma_api";
    parsed.password = "";
    apiUrl = parsed.toString();
  } finally {
    await admin.end();
  }
}, 30000);

afterAll(async () => {
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await retireLocalHmac(admin, "stage-d-test");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_stage_d_operator");
  } finally {
    await admin.end();
  }
});

describe("Stage D direct-write cleanup", () => {
  it("denies direct commitment, purchase, and outcome writes and keeps the checked functions", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin);
      await bindToken(api, hmacSecret, trade.farmerSub);
      const before = await counts(admin, trade);

      await expect(api.query(
        `INSERT INTO commitments (
           id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
         ) VALUES ($1, $2, $3, 5, 'kg', 40, '2026-11-06', 'proposed')`,
        [`c-direct-${trade.suffix}`, trade.listingId, trade.demandId],
      )).rejects.toThrow(/permission denied/);
      await expect(api.query("UPDATE commitments SET status = 'cancelled' WHERE id = $1", [trade.commitmentId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(api.query("DELETE FROM commitments WHERE id = $1", [trade.commitmentId])).rejects.toThrow(/permission denied/);

      await api.query(
        "SELECT nyuma_insert_commitment($1, $2, $3, 5, 40, '2026-11-06', 'proposed')",
        [`c-fn-${trade.suffix}`, trade.listingId, trade.demandId],
      );
      await api.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [`c-fn-${trade.suffix}`]);

      await expect(api.query(
        `INSERT INTO purchases (
           id, commitment_id, listing_id, actual_quantity, quantity_unit, actual_price_ksh_per_kg, purchase_date
         ) VALUES ($1, $2, $3, 2, 'kg', 40, '2026-11-06')`,
        [`p-direct-${trade.suffix}`, `c-fn-${trade.suffix}`, trade.listingId],
      )).rejects.toThrow(/permission denied/);
      await expect(api.query("UPDATE purchases SET actual_quantity = 1 WHERE commitment_id = $1", [trade.commitmentId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(api.query("DELETE FROM purchases WHERE commitment_id = $1", [trade.commitmentId])).rejects.toThrow(/permission denied/);
      await api.query(
        "SELECT nyuma_insert_purchase($1, $2, $3, 2, 'kg', 40, '2026-11-06')",
        [`p-fn-${trade.suffix}`, `c-fn-${trade.suffix}`, trade.listingId],
      );

      await expect(api.query(
        `INSERT INTO outcomes (
           id, listing_id, category, quantity, quantity_unit, recorded_date, notes
         ) VALUES ($1, $2, 'spoiled', 1, 'kg', '2026-11-06', '')`,
        [`o-direct-${trade.suffix}`, trade.listingId],
      )).rejects.toThrow(/permission denied/);
      await expect(api.query("UPDATE outcomes SET notes = 'changed' WHERE listing_id = $1", [trade.listingId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(api.query("DELETE FROM outcomes WHERE listing_id = $1", [trade.listingId])).rejects.toThrow(/permission denied/);
      await api.query(
        "SELECT nyuma_insert_outcome($1, $2, NULL, 'spoiled', 1, '2026-11-06', 'kept')",
        [`o-fn-${trade.suffix}`, trade.listingId],
      );

      const afterDenied = await counts(admin, trade);
      expect(afterDenied.commitments).toBe(before.commitments + 1);
      expect(afterDenied.purchases).toBe(before.purchases + 1);
      expect(afterDenied.outcomes).toBe(before.outcomes + 1);
      const original = await admin.query<{ status: string }>("SELECT status FROM commitments WHERE id = $1", [trade.commitmentId]);
      expect(original.rows[0]?.status).toBe("proposed");
      const added = await admin.query<{ status: string; notes: string }>(
        `SELECT c.status, o.notes
         FROM commitments c
         JOIN outcomes o ON o.listing_id = c.listing_id
         WHERE c.id = $1 AND o.id = $2`,
        [`c-fn-${trade.suffix}`, `o-fn-${trade.suffix}`],
      );
      expect(added.rows[0]).toEqual({ status: "confirmed", notes: "kept" });
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("stops listing and demand changes that are not the verified owner's", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin);
      const ownListing = `l-own-${trade.suffix}`;
      await bindToken(api, hmacSecret, trade.farmerSub);
      await api.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Mango', 8, 'kg', 'available', 'Kitui', 'Today', 30, 'open')`,
        [ownListing, trade.farmerId],
      );
      await api.query("UPDATE listings SET quantity = 7 WHERE id = $1", [ownListing]);
      await api.query("DELETE FROM listings WHERE id = $1", [ownListing]);

      await bindToken(api, hmacSecret, trade.otherSub);
      const quantity = await admin.query<{ quantity: string }>("SELECT quantity FROM listings WHERE id = $1", [trade.listingId]);
      await expect(api.query("UPDATE listings SET quantity = 1 WHERE id = $1", [trade.listingId])).rejects.toThrow(/could not be verified/);
      await expect(api.query("DELETE FROM listings WHERE id = $1", [trade.listingId])).rejects.toThrow(/could not be verified/);
      await expect(api.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Mango', 4, 'kg', 'available', 'Kitui', 'Today', 30, 'open')`,
        [`l-other-${trade.suffix}`, trade.farmerId],
      )).rejects.toThrow(/could not be locked/);
      const demandQuantity = await admin.query<{ requested_quantity: string }>(
        "SELECT requested_quantity FROM buyer_demands WHERE id = $1",
        [trade.demandId],
      );
      await expect(api.query("UPDATE buyer_demands SET requested_quantity = 1 WHERE id = $1", [trade.demandId])).rejects.toThrow(
        /could not be verified/,
      );
      await expect(api.query("DELETE FROM buyer_demands WHERE id = $1", [trade.demandId])).rejects.toThrow(/could not be verified/);

      await bindToken(api, hmacSecret, trade.buyerSub);
      const ownDemand = `d-own-${trade.suffix}`;
      await api.query(
        `INSERT INTO buyer_demands (
           id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Tomato', 6, 'kg', 'Nairobi', 'Today', 20, 'open')`,
        [ownDemand, trade.buyerId],
      );
      await api.query("UPDATE buyer_demands SET requested_quantity = 5 WHERE id = $1", [ownDemand]);
      await api.query("DELETE FROM buyer_demands WHERE id = $1", [ownDemand]);

      const listing = await admin.query<{ quantity: string; n: string }>(
        "SELECT quantity, (SELECT count(*) FROM listings WHERE id = $2) AS n FROM listings WHERE id = $1",
        [trade.listingId, ownListing],
      );
      expect(listing.rows[0]?.quantity).toBe(quantity.rows[0]?.quantity);
      expect(listing.rows[0]?.n).toBe("0");
      const demand = await admin.query<{ requested_quantity: string; n: string }>(
        "SELECT requested_quantity, (SELECT count(*) FROM buyer_demands WHERE id = $2) AS n FROM buyer_demands WHERE id = $1",
        [trade.demandId, ownDemand],
      );
      expect(demand.rows[0]?.requested_quantity).toBe(demandQuantity.rows[0]?.requested_quantity);
      expect(demand.rows[0]?.n).toBe("0");
      const stolen = await admin.query<{ n: string }>("SELECT count(*) AS n FROM listings WHERE id = $1", [`l-other-${trade.suffix}`]);
      expect(stolen.rows[0]?.n).toBe("0");
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("keeps role requests on the checked functions and refuses privileged roles and helpers", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    const subject = randomUUID();
    const password = randomUUID();
    try {
      await bindToken(api, hmacSecret, subject);
      const created = await api.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [subject]);
      const userId = created.rows[0]?.id;
      const rejectedSub = randomUUID();
      await expect(api.query("INSERT INTO users (auth_user_id) VALUES ($1)", [rejectedSub])).rejects.toThrow(/could not be verified/);
      await expect(api.query("DELETE FROM users WHERE id = $1", [userId])).rejects.toThrow(/permission denied/);
      const submitted = await api.query<{ id: string }>("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        subject,
        ["buyer"],
      ]);
      const requestId = submitted.rows[0]?.id;
      if (!requestId) throw new Error("Role request was not created.");
      await expect(api.query("SELECT nyuma_approve_role_request($1, NULL)", [requestId])).rejects.toThrow(/permission denied/);

      await admin.query("DROP ROLE IF EXISTS nyuma_it_stage_d_operator");
      await admin.query(`CREATE ROLE nyuma_it_stage_d_operator LOGIN NOINHERIT PASSWORD '${password}'`);
      await admin.query("GRANT nyuma_operator TO nyuma_it_stage_d_operator");
      const operatorUrl = new URL(adminUrl);
      operatorUrl.username = "nyuma_it_stage_d_operator";
      operatorUrl.password = password;
      const operator = await connectClient(operatorUrl.toString());
      try {
        await operator.query("SET ROLE nyuma_operator");
        await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [requestId]);
      } finally {
        await operator.end();
      }
      const granted = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND role = 'buyer'",
        [userId],
      );
      expect(granted.rows[0]?.n).toBe("1");
      const users = await admin.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE auth_user_id = $1", [rejectedSub]);
      expect(users.rows[0]?.n).toBe("0");

      for (const role of ["nyuma_fn_constraint", "nyuma_owner", "nyuma_operator", "nyuma_provisioner", "nyuma_fn_approve"]) {
        await expect(api.query(`SET ROLE ${role}`)).rejects.toThrow(/permission denied/);
      }
      for (const call of [
        "SELECT nyuma_lock_listing('missing')",
        "SELECT nyuma_lock_for_purchase('missing')",
        "SELECT nyuma_listing_held_grams('missing')",
        "SELECT nyuma_grams(1)",
        "SELECT nyuma_assert_listing_quantities('missing')",
        "SELECT nyuma_clear_active_role('00000000-0000-0000-0000-000000000000', 'farmer')",
        "SELECT nyuma_grant_administrator('00000000-0000-0000-0000-000000000000')",
      ]) {
        await expect(api.query(call)).rejects.toThrow(/permission denied/);
      }
      const escalation = await api.query<{ superuser: boolean; bypass: boolean; member: boolean }>(
        `SELECT rolsuper AS superuser,
                rolbypassrls AS bypass,
                pg_has_role(current_user, 'nyuma_fn_constraint', 'member') AS member
         FROM pg_roles WHERE rolname = current_user`,
      );
      expect(escalation.rows[0]).toEqual({ superuser: false, bypass: false, member: false });
      await expect(api.query("GRANT nyuma_fn_constraint TO nyuma_api")).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("DROP ROLE IF EXISTS nyuma_it_stage_d_operator").catch(() => undefined);
      await admin.end();
      await api.end();
    }
  });

  it("leaves row security off and does not store the sample workspace", async () => {
    const admin = await connectClient(adminUrl);
    try {
      const security = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );
      expect(security.rows.length).toBeGreaterThan(0);
      expect(security.rows.every((row) => row.relrowsecurity === false && row.relforcerowsecurity === false)).toBe(true);
      const policies = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_policies WHERE schemaname = 'public'");
      expect(policies.rows[0]?.count).toBe("0");
      const names = await admin.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('nyuma.coordination.v1', 'nyuma.session.v1', 'nyuma.decisionSupport.scenario.v1')`,
      );
      expect(names.rows).toEqual([]);
      const privileges = await admin.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = 'nyuma_app' AND table_schema = 'public'
         ORDER BY table_name, privilege_type`,
      );
      expect(privileges.rows).toEqual([
        { table_name: "buyer_demands", privilege_type: "DELETE" },
        { table_name: "buyer_demands", privilege_type: "INSERT" },
        { table_name: "buyer_demands", privilege_type: "SELECT" },
        { table_name: "buyer_demands", privilege_type: "UPDATE" },
        { table_name: "commitments", privilege_type: "SELECT" },
        { table_name: "coordination_ids", privilege_type: "SELECT" },
        { table_name: "listings", privilege_type: "DELETE" },
        { table_name: "listings", privilege_type: "INSERT" },
        { table_name: "listings", privilege_type: "SELECT" },
        { table_name: "listings", privilege_type: "UPDATE" },
        { table_name: "outcomes", privilege_type: "SELECT" },
        { table_name: "purchases", privilege_type: "SELECT" },
        { table_name: "user_roles", privilege_type: "SELECT" },
        { table_name: "users", privilege_type: "INSERT" },
        { table_name: "users", privilege_type: "SELECT" },
      ]);
    } finally {
      await admin.end();
    }
  });
});

async function counts(admin: Client, trade: { listingId: string }): Promise<{ commitments: number; purchases: number; outcomes: number }> {
  const result = await admin.query<{ commitments: string; purchases: string; outcomes: string }>(
    `SELECT
       (SELECT count(*) FROM commitments WHERE listing_id = $1) AS commitments,
       (SELECT count(*) FROM purchases WHERE listing_id = $1) AS purchases,
       (SELECT count(*) FROM outcomes WHERE listing_id = $1) AS outcomes`,
    [trade.listingId],
  );
  const row = result.rows[0];
  return {
    commitments: Number(row?.commitments ?? 0),
    purchases: Number(row?.purchases ?? 0),
    outcomes: Number(row?.outcomes ?? 0),
  };
}

async function openTrade(admin: Client): Promise<{
  suffix: string;
  farmerId: string;
  farmerSub: string;
  buyerId: string;
  buyerSub: string;
  otherSub: string;
  listingId: string;
  demandId: string;
  commitmentId: string;
}> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const farmerSub = randomUUID();
  const buyerSub = randomUUID();
  const otherSub = randomUUID();
  const farmer = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [farmerSub]);
  const buyer = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [buyerSub]);
  const other = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [otherSub]);
  const farmerId = farmer.rows[0]?.id;
  const buyerId = buyer.rows[0]?.id;
  const otherId = other.rows[0]?.id;
  if (!farmerId || !buyerId || !otherId) throw new Error("Fixture accounts were not created.");
  await admin.query(
    "INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer'), ($2, 'buyer'), ($3, 'farmer')",
    [farmerId, buyerId, otherId],
  );
  const listingId = `l-${suffix}`;
  const demandId = `d-${suffix}`;
  const commitmentId = `c-${suffix}`;
  await admin.query(
    `INSERT INTO listings (
       id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
     ) VALUES ($1, $2, 'Watermelon', 80, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
    [listingId, farmerId],
  );
  await admin.query(
    `INSERT INTO buyer_demands (
       id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
     ) VALUES ($1, $2, 'Watermelon', 80, 'kg', 'Nairobi', 'Today', 42, 'open')`,
    [demandId, buyerId],
  );
  await admin.query(
    `INSERT INTO commitments (
       id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
     ) VALUES ($1, $2, $3, 20, 'kg', 40, '2026-11-06', 'proposed')`,
    [commitmentId, listingId, demandId],
  );
  return { suffix, farmerId, farmerSub, buyerId, buyerSub, otherSub, listingId, demandId, commitmentId };
}
