import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { signTestToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { bindToken, installLocalHmac, localAudience, localIssuer, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const hmacSecret = new TextEncoder().encode("local-stage-c-secret-not-a-project");

let adminUrl = "";
let apiUrl = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Stage C integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    await installLocalHmac(admin, hmacSecret, "stage-c-test");
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
    await retireLocalHmac(admin, "stage-c-test");
  } finally {
    await admin.end();
  }
});

describe("Stage C privileged functions", () => {
  it("keeps row security off and does not let nyuma_api assume nyuma_fn_constraint", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const security = await admin.query<{ forced: string; enabled: string }>(
        `SELECT count(*) FILTER (WHERE c.relrowsecurity) AS enabled,
                count(*) FILTER (WHERE c.relforcerowsecurity) AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );
      expect(security.rows[0]).toEqual({ enabled: "0", forced: "0" });

      const roles = await admin.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolname, rolbypassrls, rolsuper
         FROM pg_roles
         WHERE rolname IN ('nyuma_api', 'nyuma_fn_constraint', 'nyuma_owner')
         ORDER BY rolname`,
      );
      expect(roles.rows).toEqual([
        { rolname: "nyuma_api", rolbypassrls: false, rolsuper: false },
        { rolname: "nyuma_fn_constraint", rolbypassrls: true, rolsuper: false },
        { rolname: "nyuma_owner", rolbypassrls: false, rolsuper: false },
      ]);

      const who = await api.query<{ current_user: string; member: boolean }>(
        `SELECT current_user, pg_has_role(session_user, 'nyuma_fn_constraint', 'MEMBER') AS member`,
      );
      expect(who.rows[0]).toEqual({ current_user: "nyuma_api", member: false });
      await expect(api.query("SET ROLE nyuma_fn_constraint")).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_listing_held_grams('missing')")).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_lock_listing('missing')")).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_lock_for_purchase('missing')")).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_clear_active_role($1, 'farmer')", [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_approve_role_request($1, NULL)", [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(api.query("SELECT nyuma_grant_administrator($1)", [randomUUID()])).rejects.toThrow(/permission denied/);
      await expect(api.query("SET session_replication_role = replica")).rejects.toThrow(/permission denied/);
      await expect(api.query("ALTER TABLE commitments DISABLE TRIGGER USER")).rejects.toThrow(/permission denied|must be owner/);
      const paths = await admin.query<{ proname: string }>(
        `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosecdef
           AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS config
             WHERE config LIKE 'search_path=%'
           )`,
      );
      expect(paths.rows).toEqual([]);
      const still = await api.query<{ current_user: string }>("SELECT current_user");
      expect(still.rows[0]?.current_user).toBe("nyuma_api");
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("runs quantity checks as nyuma_fn_constraint and counts every child row", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const owners = await admin.query<{ proname: string; owner: string; prosecdef: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY($1::text[])
         ORDER BY p.proname`,
        [[
          "nyuma_commitments_check",
          "nyuma_purchases_check",
          "nyuma_assert_listing_quantities",
          "nyuma_listing_held_grams",
          "nyuma_guard_role_removal",
        ]],
      );
      expect(owners.rows).toEqual([
        { proname: "nyuma_assert_listing_quantities", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_commitments_check", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_guard_role_removal", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_listing_held_grams", owner: "nyuma_fn_constraint", prosecdef: true },
        { proname: "nyuma_purchases_check", owner: "nyuma_fn_constraint", prosecdef: true },
      ]);

      const trade = await openTrade(admin, 100, 40);
      await bindToken(api, hmacSecret, trade.farmerSub);
      await api.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [trade.commitmentId]);
      const secondDemand = `d2-${trade.suffix}`;
      const secondCommitment = `c2-${trade.suffix}`;
      await admin.query(
        `INSERT INTO buyer_demands (
           id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 80, 'kg', 'Nairobi', 'Today', 42, 'open')`,
        [secondDemand, trade.otherBuyerId],
      );
      await expect(admin.query(
        `INSERT INTO commitments (
           id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
         ) VALUES ($1, $2, $3, 70, 'kg', 40, '2026-11-06', 'confirmed')`,
        [secondCommitment, trade.listingId, secondDemand],
      )).rejects.toThrow(/quantity/);
      const held = await admin.query<{ grams: string }>("SELECT nyuma_listing_held_grams($1) AS grams", [trade.listingId]);
      expect(Number(held.rows[0]?.grams)).toBe(40000);
      const extra = await admin.query<{ n: string }>("SELECT count(*) AS n FROM commitments WHERE id = $1", [secondCommitment]);
      expect(extra.rows[0]?.n).toBe("0");

      await expect(api.query(
        "SELECT nyuma_insert_purchase($1, $2, $3, 50, 'kg', 40, '2026-11-06')",
        [`p-over-${trade.suffix}`, trade.commitmentId, trade.listingId],
      )).rejects.toThrow(/quantity/);
      await expect(api.query(
        `INSERT INTO purchases (
           id, commitment_id, listing_id, actual_quantity, quantity_unit, actual_price_ksh_per_kg, purchase_date
         ) VALUES ($1, $2, $3, 50, 'kg', 40, '2026-11-06')`,
        [`p-direct-${trade.suffix}`, trade.commitmentId, trade.listingId],
      )).rejects.toThrow(/permission denied/);
      const purchases = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM purchases WHERE commitment_id = $1",
        [trade.commitmentId],
      );
      expect(purchases.rows[0]?.n).toBe("0");
      const status = await admin.query<{ status: string }>("SELECT status FROM commitments WHERE id = $1", [trade.commitmentId]);
      expect(status.rows[0]?.status).toBe("confirmed");
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("rejects a missing, invalid, expired, or suspended identity without changing the commitment", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin, 80, 20);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [trade.commitmentId])).rejects.toThrow(
        /could not be verified/,
      );
      await api.query("SELECT set_config('nyuma.access_token', 'not-a-token', false)");
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [trade.commitmentId])).rejects.toThrow(
        /could not be verified/,
      );
      const expired = await signTestToken(hmacSecret, {
        subject: trade.farmerSub,
        issuer: localIssuer,
        audience: localAudience,
        expiresIn: Math.floor(Date.now() / 1000) - 120,
      });
      await api.query("SELECT set_config('nyuma.access_token', $1, false)", [expired]);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [trade.commitmentId])).rejects.toThrow(
        /could not be verified/,
      );
      const forged = await signTestToken(new TextEncoder().encode("different-test-secret"), {
        subject: trade.farmerSub,
        issuer: localIssuer,
        audience: localAudience,
        expiresIn: "30m",
      });
      await api.query("SELECT set_config('nyuma.access_token', $1, false)", [forged]);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [trade.commitmentId])).rejects.toThrow(
        /could not be verified/,
      );
      await bindToken(api, hmacSecret, trade.farmerSub);
      await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [trade.farmerId]);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [trade.commitmentId])).rejects.toThrow(
        /could not be verified/,
      );
      await expect(api.query(
        "SELECT nyuma_insert_purchase($1, $2, $3, 1, 'kg', 40, '2026-11-06')",
        [`p-sus-${trade.suffix}`, trade.commitmentId, trade.listingId],
      )).rejects.toThrow(/could not be verified/);
      const state = await admin.query<{ status: string; purchases: string }>(
        `SELECT c.status, (SELECT count(*) FROM purchases p WHERE p.commitment_id = c.id) AS purchases
         FROM commitments c WHERE c.id = $1`,
        [trade.commitmentId],
      );
      expect(state.rows[0]).toEqual({ status: "proposed", purchases: "0" });
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("stops one account from changing another account's commitment, purchase, or workspace", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin, 80, 20);
      await bindToken(api, hmacSecret, trade.otherBuyerSub);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [trade.commitmentId])).rejects.toThrow(
        /does not exist/,
      );
      await expect(api.query(
        "SELECT nyuma_insert_purchase($1, $2, $3, 1, 'kg', 40, '2026-11-06')",
        [`p-cross-${trade.suffix}`, trade.commitmentId, trade.listingId],
      )).rejects.toThrow(/does not exist/);
      const beforeRole = await admin.query<{ active_role: string | null }>(
        "SELECT active_role FROM users WHERE id = $1",
        [trade.farmerId],
      );
      let roleError = "";
      try {
        await api.query("SELECT nyuma_set_active_role($1, 'farmer')", [trade.farmerId]);
      } catch (error) {
        roleError = error instanceof Error ? error.message : String(error);
      }
      expect(roleError).toMatch(/not assigned/);
      expect(roleError).not.toContain(trade.farmerId);
      await api.query("SELECT set_config('nyuma.user_id', $1, false)", [trade.farmerId]);
      await expect(api.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [trade.commitmentId])).rejects.toThrow(
        /does not exist/,
      );
      const state = await admin.query<{ status: string; purchases: string; active_role: string | null }>(
        `SELECT c.status,
                (SELECT count(*) FROM purchases p WHERE p.commitment_id = c.id) AS purchases,
                u.active_role
         FROM commitments c
         JOIN listings l ON l.id = c.listing_id
         JOIN users u ON u.id = l.owner_id
         WHERE c.id = $1`,
        [trade.commitmentId],
      );
      expect(state.rows[0]).toEqual({
        status: "proposed",
        purchases: "0",
        active_role: beforeRole.rows[0]?.active_role ?? null,
      });
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("keeps a participant confirmation, purchase, and workspace selection", async () => {
    const admin = await connectClient(adminUrl);
    const farmer = await connectClient(apiUrl);
    const buyer = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin, 80, 30);
      await bindToken(farmer, hmacSecret, trade.farmerSub);
      const verified = await farmer.query<{ id: string }>("SELECT nyuma_verified_account_id() AS id");
      expect(verified.rows[0]?.id).toBe(trade.farmerId);
      await farmer.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [trade.commitmentId]);
      await farmer.query("SELECT nyuma_set_active_role($1, 'farmer')", [trade.farmerId]);
      await bindToken(buyer, hmacSecret, trade.buyerSub);
      const buyerVerified = await buyer.query<{ id: string }>("SELECT nyuma_verified_account_id() AS id");
      expect(buyerVerified.rows[0]?.id).toBe(trade.buyerId);
      const purchaseId = `p-ok-${trade.suffix}`;
      await buyer.query(
        "SELECT nyuma_insert_purchase($1, $2, $3, 10, 'kg', 40, '2026-11-06')",
        [purchaseId, trade.commitmentId, trade.listingId],
      );
      const state = await admin.query<{ status: string; quantity: string; active_role: string }>(
        `SELECT c.status, p.actual_quantity::text AS quantity, u.active_role
         FROM commitments c
         JOIN purchases p ON p.commitment_id = c.id
         JOIN users u ON u.id = $2
         WHERE c.id = $1`,
        [trade.commitmentId, trade.farmerId],
      );
      expect(state.rows[0]?.status).toBe("confirmed");
      expect(Number(state.rows[0]?.quantity)).toBe(10);
      expect(state.rows[0]?.active_role).toBe("farmer");
    } finally {
      await admin.end();
      await farmer.end();
      await buyer.end();
    }
  });

  it("keeps concurrent purchases inside the agreed quantity", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin, 80, 30);
      await bindToken(api, hmacSecret, trade.farmerSub);
      await api.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [trade.commitmentId]);
      const left = connectClient(apiUrl);
      const right = connectClient(apiUrl);
      const [a, b] = await Promise.all([left, right]);
      try {
        await Promise.all([
          purchase(a, trade, `p-a-${trade.suffix}`),
          purchase(b, trade, `p-b-${trade.suffix}`),
        ]);
      } finally {
        await a.end();
        await b.end();
      }
      const totals = await admin.query<{ n: string; grams: string }>(
        `SELECT count(*) AS n, COALESCE(SUM(nyuma_grams(actual_quantity)), 0) AS grams
         FROM purchases WHERE commitment_id = $1`,
        [trade.commitmentId],
      );
      expect(Number(totals.rows[0]?.n)).toBe(1);
      expect(Number(totals.rows[0]?.grams)).toBeLessThanOrEqual(30000);
    } finally {
      await admin.end();
      await api.end();
    }
  });

  it("runs the quantity trigger as nyuma_fn_constraint even when nyuma_api cannot read commitments", async () => {
    const admin = await connectClient(adminUrl);
    try {
      const trade = await openTrade(admin, 100, 20);
      await admin.query("BEGIN");
      // Stage D revokes this insert. The grant lives only inside this transaction so the
      // quantity trigger can still be invoked directly, then ROLLBACK restores the revoke.
      await admin.query("GRANT INSERT ON commitments TO nyuma_app");
      await admin.query("REVOKE SELECT ON commitments FROM nyuma_app");
      await admin.query("SET LOCAL ROLE nyuma_api");
      const added = `c-seen-${trade.suffix}`;
      await admin.query(
        `INSERT INTO commitments (
           id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
         ) VALUES ($1, $2, $3, 10, 'kg', 40, '2026-11-06', 'proposed')`,
        [added, trade.listingId, trade.demandId],
      );
      await admin.query("SAVEPOINT before_over");
      await expect(admin.query(
        `INSERT INTO commitments (
           id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
         ) VALUES ($1, $2, $3, 90, 'kg', 40, '2026-11-06', 'proposed')`,
        [`c-over-${trade.suffix}`, trade.listingId, trade.demandId],
      )).rejects.toThrow(/quantity/);
      await admin.query("ROLLBACK TO SAVEPOINT before_over");
      await admin.query("RESET ROLE");
      const visible = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM commitments WHERE id = ANY($1::text[])",
        [[trade.commitmentId, added]],
      );
      expect(visible.rows[0]?.n).toBe("2");
      await admin.query("ROLLBACK");
      const restored = await admin.query<{ listing_select: boolean }>(
        "SELECT has_table_privilege('nyuma_app', 'commitments', 'SELECT') AS listing_select",
      );
      expect(restored.rows[0]?.listing_select).toBe(true);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  });

  it("rejects a suspended role request and a cross-account listing insert without writing a row", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    try {
      const trade = await openTrade(admin, 80, 20);
      await bindToken(api, hmacSecret, trade.farmerSub);
      await admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [trade.farmerId]);
      await expect(api.query("SELECT id FROM nyuma_submit_role_requests($1, $2::text[])", [
        trade.farmerSub,
        ["trader"],
      ])).rejects.toThrow(/account-disabled/);
      const requests = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM role_requests WHERE user_id = $1",
        [trade.farmerId],
      );
      expect(requests.rows[0]?.n).toBe("0");
      await admin.query("UPDATE users SET status = 'active' WHERE id = $1", [trade.farmerId]);
      await bindToken(api, hmacSecret, trade.farmerSub);
      const foreignListing = `foreign-${trade.suffix}`;
      await expect(api.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 5, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
        [foreignListing, trade.otherBuyerId],
      )).rejects.toThrow(/could not be locked/);
      const ownListing = `own-${trade.suffix}`;
      await api.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 5, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
        [ownListing, trade.farmerId],
      );
      const rows = await admin.query<{ id: string }>(
        "SELECT id FROM listings WHERE id = ANY($1::text[]) ORDER BY id",
        [[foreignListing, ownListing]],
      );
      expect(rows.rows.map((row) => row.id)).toEqual([ownListing]);
    } finally {
      await admin.end();
      await api.end();
    }
  });
});

async function purchase(client: Client, trade: Trade, purchaseId: string): Promise<void> {
  await bindToken(client, hmacSecret, trade.farmerSub);
  await client.query(
    "SELECT nyuma_insert_purchase($1, $2, $3, 20, 'kg', 40, '2026-11-06')",
    [purchaseId, trade.commitmentId, trade.listingId],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/quantity|deadlock|could not serialize|canceling statement/i.test(message)) throw error;
  });
}

interface Trade {
  suffix: string;
  farmerId: string;
  farmerSub: string;
  buyerId: string;
  buyerSub: string;
  otherBuyerId: string;
  otherBuyerSub: string;
  listingId: string;
  demandId: string;
  commitmentId: string;
}

async function openTrade(admin: Client, listingQuantity: number, agreedQuantity: number): Promise<Trade> {
  const suffix = randomUUID();
  const farmerSub = randomUUID();
  const buyerSub = randomUUID();
  const otherBuyerSub = randomUUID();
  const farmer = await admin.query<{ id: string }>(
    "INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id",
    [farmerSub],
  );
  const buyer = await admin.query<{ id: string }>(
    "INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id",
    [buyerSub],
  );
  const other = await admin.query<{ id: string }>(
    "INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id",
    [otherBuyerSub],
  );
  const farmerId = farmer.rows[0]?.id;
  const buyerId = buyer.rows[0]?.id;
  const otherBuyerId = other.rows[0]?.id;
  if (!farmerId || !buyerId || !otherBuyerId) throw new Error("Fixture accounts were not created.");
  await admin.query(
    "INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer'), ($2, 'buyer'), ($3, 'buyer')",
    [farmerId, buyerId, otherBuyerId],
  );
  const listingId = `l-${suffix}`;
  const demandId = `d-${suffix}`;
  const commitmentId = `c-${suffix}`;
  await admin.query(
    `INSERT INTO listings (
       id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
     ) VALUES ($1, $2, 'Watermelon', $3, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
    [listingId, farmerId, listingQuantity],
  );
  await admin.query(
    `INSERT INTO buyer_demands (
       id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
     ) VALUES ($1, $2, 'Watermelon', $3, 'kg', 'Nairobi', 'Today', 42, 'open')`,
    [demandId, buyerId, listingQuantity],
  );
  await admin.query(
    `INSERT INTO commitments (
       id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
     ) VALUES ($1, $2, $3, $4, 'kg', 40, '2026-11-06', 'proposed')`,
    [commitmentId, listingId, demandId, agreedQuantity],
  );
  return {
    suffix,
    farmerId,
    farmerSub,
    buyerId,
    buyerSub,
    otherBuyerId,
    otherBuyerSub,
    listingId,
    demandId,
    commitmentId,
  };
}
