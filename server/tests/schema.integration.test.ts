import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientBase } from "pg";
import { isTimeCompatible } from "../../src/lib/decisionEngine.js";
import type { TimeWindow } from "../../src/types/decision.js";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { databaseReadiness } from "../src/db/ready.js";
import { runTransaction } from "../src/db/transaction.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const hmacSecret = new TextEncoder().encode("local-schema-test-secret-not-a-project");

const databaseUrl = process.env.DATABASE_URL;
const windows: TimeWindow[] = ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"];

let adminUrl = "";
let appUrl = "";
let postgresVersion = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Integration tests were not skipped and were not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  const applied = await applyMigrations(adminUrl);
  const again = await applyMigrations(adminUrl);
  expect(again).toEqual([]);
  console.log(`Migrations applied by this call: ${applied.length === 0 ? "(none, already present)" : applied.join(", ")}`);
  const client = await connectClient(adminUrl);
  try {
    const version = await client.query<{ version: string; num: string }>(
      "SELECT version(), current_setting('server_version_num') AS num",
    );
    postgresVersion = `${version.rows[0]?.version} (${version.rows[0]?.num})`;
    console.log(`PostgreSQL ${postgresVersion}`);
    const recorded = await client.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(recorded.rows.map((row) => row.version)).toEqual([
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
    expect(Number(version.rows[0]?.num)).toBeGreaterThanOrEqual(140000);
    const password = randomUUID();
    await client.query("DROP ROLE IF EXISTS nyuma_it_app");
    await client.query(`CREATE ROLE nyuma_it_app LOGIN PASSWORD '${password}'`);
    await client.query("GRANT nyuma_app TO nyuma_it_app");
    const parsed = new URL(adminUrl);
    parsed.username = "nyuma_it_app";
    parsed.password = password;
    appUrl = parsed.toString();
    await installLocalHmac(client, hmacSecret, "schema-test");
  } finally {
    await client.end();
  }
}, 30000);

afterAll(async () => {
  if (!adminUrl) return;
  const client = await connectClient(adminUrl);
  try {
    await retireLocalHmac(client, "schema-test");
    await client.query("DROP ROLE IF EXISTS nyuma_it_app");
  } finally {
    await client.end();
  }
});

describe("executed PostgreSQL integration", () => {
  it("creates the schema and answers readiness from a real connection", async () => {
    const client = await connectClient(adminUrl);
    try {
      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
        [["users", "user_roles", "listings", "buyer_demands", "commitments", "purchases", "outcomes"]],
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "buyer_demands",
        "commitments",
        "listings",
        "outcomes",
        "purchases",
        "user_roles",
        "users",
      ]);
      expect(await databaseReadiness(adminUrl)).toBe("ready");
      expect(postgresVersion).toContain("PostgreSQL");
    } finally {
      await client.end();
    }
  });

  it("blocks the application role from assigning roles and still lets the provisioner grant administrator", async () => {
    const admin = await connectClient(adminUrl);
    const app = await connectClient(appUrl);
    try {
      const userId = await insertUser(admin);
      await app.query("SELECT set_config('nyuma.allow_admin_grant', 'true', false)");
      await app.query("SELECT set_config('nyuma.trusted_operator', 'true', false)");
      await expect(app.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer')", [userId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'administrator')", [userId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'farmer'", [userId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("SELECT nyuma_grant_administrator($1)", [userId])).rejects.toThrow(/permission denied/);
      for (const role of [
        "nyuma_provisioner",
        "nyuma_operator",
        "nyuma_fn_request",
        "nyuma_fn_approve",
        "nyuma_fn_reject",
        "nyuma_fn_revoke",
      ]) {
        await expect(app.query(`SET ROLE ${role}`)).rejects.toThrow(/permission denied/);
      }
      await expect(app.query("GRANT nyuma_provisioner TO nyuma_it_app")).rejects.toThrow(/permission denied/);
      const roles = await app.query<{ role: string }>("SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role", [userId]);
      expect(roles.rows).toEqual([]);

      await admin.query("SET ROLE nyuma_provisioner");
      await admin.query("SELECT nyuma_grant_administrator($1)", [userId]);
      await admin.query("RESET ROLE");
      const granted = await admin.query<{ role: string }>("SELECT role FROM user_roles WHERE user_id = $1 AND role = 'administrator'", [
        userId,
      ]);
      expect(granted.rowCount).toBe(1);
      await expect(app.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'administrator'", [userId])).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.end();
      await app.end();
    }
  });

  it("rejects a listing or demand when the locked account loses the required role", async () => {
    const holder = await connectClient(adminUrl);
    const racer = await connectClient(adminUrl);
    const userId = await insertUser(holder);
    await holder.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer')", [userId]);
    const listingId = `race-list-${randomUUID()}`;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT nyuma_lock_user($1)", [userId]);
      let finished = false;
      const pending = (async () => {
        await racer.query("BEGIN");
        try {
          await racer.query(insertListingSql(), listingArgs(listingId, userId, { quantity: 10, window: "Today", kind: "available" }));
          await racer.query("COMMIT");
          return "committed";
        } catch (error) {
          await racer.query("ROLLBACK");
          return error instanceof Error ? error.message : String(error);
        } finally {
          finished = true;
        }
      })();
      await delay(400);
      expect(finished).toBe(false);
      await holder.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'farmer'", [userId]);
      await holder.query("COMMIT");
      expect(await pending).toMatch(/farmer or trader/);
      const owned = await holder.query("SELECT count(*) AS n FROM listings WHERE owner_id = $1", [userId]);
      expect(Number(owned.rows[0]?.n)).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await racer.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await racer.end();
    }
  });

  it("rejects role removal when a listing insert already holds the account lock", async () => {
    const holder = await connectClient(adminUrl);
    const racer = await connectClient(adminUrl);
    const userId = await insertUser(holder);
    const buyerId = await insertUser(holder);
    await holder.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer'), ($2, 'buyer')", [userId, buyerId]);
    const listingId = `race-keep-${randomUUID()}`;
    const demandId = `race-demand-${randomUUID()}`;
    try {
      await holder.query("BEGIN");
      await holder.query(insertListingSql(), listingArgs(listingId, userId, { quantity: 10, window: "Today", kind: "available" }));
      let finished = false;
      const pending = (async () => {
        await racer.query("BEGIN");
        try {
          await racer.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'farmer'", [userId]);
          await racer.query("COMMIT");
          return "committed";
        } catch (error) {
          await racer.query("ROLLBACK");
          return error instanceof Error ? error.message : String(error);
        } finally {
          finished = true;
        }
      })();
      await delay(400);
      expect(finished).toBe(false);
      await holder.query("COMMIT");
      expect(await pending).toMatch(/still owns a listing/);
      const role = await holder.query("SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND role = 'farmer'", [userId]);
      expect(Number(role.rows[0]?.n)).toBe(1);

      await holder.query("BEGIN");
      await holder.query(insertDemandSql(), demandArgs(demandId, buyerId, { quantity: 5, window: "Today", commodity: "Mango" }));
      const demandPending = (async () => {
        await racer.query("BEGIN");
        try {
          await racer.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'buyer'", [buyerId]);
          await racer.query("COMMIT");
          return "committed";
        } catch (error) {
          await racer.query("ROLLBACK");
          return error instanceof Error ? error.message : String(error);
        }
      })();
      await delay(300);
      await holder.query("COMMIT");
      expect(await demandPending).toMatch(/buyer role/);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await racer.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await racer.end();
    }
  });

  it("executes the collection-window function for every domain pair", async () => {
    const client = await connectClient(adminUrl);
    try {
      for (const seller of windows) {
        for (const buyer of windows) {
          const result = await client.query<{ ok: boolean }>("SELECT nyuma_is_time_compatible($1, $2) AS ok", [seller, buyer]);
          expect(result.rows[0]?.ok).toBe(isTimeCompatible(seller, buyer));
        }
      }
    } finally {
      await client.end();
    }
  });

  it("stops two concurrent commitments from over-allocating one listing", async () => {
    const fixture = await openTrade(100, 100);
    try {
      const results = await Promise.all([
        attempt(adminUrl, insertCommitmentSql(), commitmentArgs(`c-a-${fixture.suffix}`, fixture.listingId, fixture.demandId, 60)),
        attempt(adminUrl, insertCommitmentSql(), commitmentArgs(`c-b-${fixture.suffix}`, fixture.listingId, fixture.demandId, 60)),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.some((result) => !result.ok && /listing quantity/.test(result.message))).toBe(true);
      expect(await heldListing(fixture.listingId)).toBe(60000);
    } finally {
      await fixture.close();
    }
  });

  it("stops two concurrent commitments from over-allocating one buyer demand", async () => {
    const supplier = await connectClient(adminUrl);
    const suffix = randomUUID();
    const owner = await insertUser(supplier);
    const buyer = await insertUser(supplier);
    await supplier.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'trader'), ($2, 'buyer')", [owner, buyer]);
    const listingA = `wide-a-${suffix}`;
    const listingB = `wide-b-${suffix}`;
    const demandId = `shared-demand-${suffix}`;
    await supplier.query(insertListingSql(), listingArgs(listingA, owner, { quantity: 200, window: "Today", kind: "available" }));
    await supplier.query(insertListingSql(), listingArgs(listingB, owner, { quantity: 200, window: "Today", kind: "available" }));
    await supplier.query(insertDemandSql(), demandArgs(demandId, buyer, { quantity: 100, window: "Today", commodity: "Watermelon" }));
    await supplier.end();
    const results = await Promise.all([
      attempt(adminUrl, insertCommitmentSql(), commitmentArgs(`d-a-${suffix}`, listingA, demandId, 60)),
      attempt(adminUrl, insertCommitmentSql(), commitmentArgs(`d-b-${suffix}`, listingB, demandId, 60)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.some((result) => !result.ok && /buyer requirement/.test(result.message))).toBe(true);
    const client = await connectClient(adminUrl);
    try {
      const held = await client.query<{ grams: string }>("SELECT nyuma_demand_held_grams($1) AS grams", [demandId]);
      expect(Number(held.rows[0]?.grams)).toBe(60000);
    } finally {
      await client.end();
    }
  });

  it("enforces purchase limits, cancellation, cross-listing rejection, and rollback", async () => {
    const fixture = await openTrade(100, 100);
    const client = await connectClient(adminUrl);
    try {
      await actAs(client, fixture.ownerId);
      const commitmentId = `buy-${fixture.suffix}`;
      await client.query(insertCommitmentSql(), commitmentArgs(commitmentId, fixture.listingId, fixture.demandId, 60, "proposed"));
      await expect(
        client.query("SELECT nyuma_insert_purchase($1, $2, $3, 40, 'kg', 40, '2026-11-06')", [
          `p-${fixture.suffix}`,
          commitmentId,
          fixture.listingId,
        ]),
      ).rejects.toThrow(/confirmed/);
      const cancelledId = `cancelled-${fixture.suffix}`;
      await client.query(insertCommitmentSql(), commitmentArgs(cancelledId, fixture.listingId, fixture.demandId, 5, "confirmed"));
      await client.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [cancelledId]);
      await expect(
        client.query("SELECT nyuma_insert_purchase($1, $2, $3, 1, 'kg', 40, '2026-11-06')", [
          `cancelled-p-${fixture.suffix}`,
          cancelledId,
          fixture.listingId,
        ]),
      ).rejects.toThrow(/cancelled/);
      await expect(client.query("SELECT nyuma_set_commitment_status($1, 'fulfilled')", [commitmentId])).rejects.toThrow(
        /cannot become/,
      );
      await client.query("SELECT nyuma_set_commitment_status($1, 'confirmed')", [commitmentId]);
      await client.query("SELECT nyuma_insert_purchase($1, $2, $3, 40, 'kg', 40, '2026-11-06')", [
        `p-${fixture.suffix}`,
        commitmentId,
        fixture.listingId,
      ]);
      await expect(
        client.query("SELECT nyuma_insert_purchase($1, $2, $3, 21, 'kg', 40, '2026-11-06')", [
          `p2-${fixture.suffix}`,
          commitmentId,
          fixture.listingId,
        ]),
      ).rejects.toThrow(/agreed quantity/);
      const otherListing = `other-${fixture.suffix}`;
      await client.query(insertListingSql(), listingArgs(otherListing, fixture.ownerId, { quantity: 50, window: "Today", kind: "available" }));
      await expect(
        client.query("SELECT nyuma_insert_purchase($1, $2, $3, 1, 'kg', 40, '2026-11-06')", [
          `cross-${fixture.suffix}`,
          commitmentId,
          otherListing,
        ]),
      ).rejects.toThrow(/same listing/);
      const status = await client.query<{ status: string }>("SELECT status FROM commitments WHERE id = $1", [commitmentId]);
      expect(status.rows[0]?.status).toBe("confirmed");
      expect(await heldListing(fixture.listingId)).toBe(60000);
      const app = await connectClient(appUrl);
      try {
        await expect(app.query("UPDATE commitments SET status = 'cancelled' WHERE id = $1", [commitmentId])).rejects.toThrow(
          /permission denied/,
        );
        await actAs(app, fixture.ownerId);
        await app.query("SELECT nyuma_set_commitment_status($1, 'fulfilled')", [commitmentId]);
      } finally {
        await app.end();
      }
      expect(await heldListing(fixture.listingId)).toBe(40000);
      await expect(client.query("UPDATE purchases SET actual_quantity = 1 WHERE id = $1", [`p-${fixture.suffix}`])).rejects.toThrow(
        /cannot be changed/,
      );
      await expect(client.query("DELETE FROM purchases WHERE id = $1", [`p-${fixture.suffix}`])).rejects.toThrow(/cannot be deleted/);
      await expect(client.query("DELETE FROM commitments WHERE id = $1", [commitmentId])).rejects.toThrow(/kept for history/);
      await expect(client.query("DELETE FROM listings WHERE id = $1", [fixture.listingId])).rejects.toThrow(/restrict|foreign key|violates/i);

      await client.query("BEGIN");
      const rolled = `rolled-${fixture.suffix}`;
      await client.query(insertCommitmentSql(), commitmentArgs(rolled, otherListing, fixture.demandId, 10, "proposed"));
      await expect(
        client.query(insertCommitmentSql(), commitmentArgs(`rolled-over-${fixture.suffix}`, otherListing, fixture.demandId, 100, "proposed")),
      ).rejects.toThrow(/buyer requirement|listing quantity/);
      await client.query("ROLLBACK");
      const leftover = await client.query("SELECT count(*) AS n FROM commitments WHERE id = $1", [rolled]);
      expect(Number(leftover.rows[0]?.n)).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
      await fixture.close();
    }
  });

  it("accounts a purchase once when sold outcomes are linked, and rejects overlap", async () => {
    const fixture = await openTrade(100, 100);
    const client = await connectClient(adminUrl);
    try {
      await actAs(client, fixture.ownerId);
      const commitmentId = `sold-${fixture.suffix}`;
      const purchaseId = `sold-p-${fixture.suffix}`;
      await client.query(insertCommitmentSql(), commitmentArgs(commitmentId, fixture.listingId, fixture.demandId, 40, "confirmed"));
      await client.query("SELECT nyuma_insert_purchase($1, $2, $3, 40, 'kg', 39.5, '2026-11-06')", [
        purchaseId,
        commitmentId,
        fixture.listingId,
      ]);
      await expect(
        client.query(insertOutcomeSql(), outcomeArgs(`bad-cat-${fixture.suffix}`, fixture.listingId, commitmentId, purchaseId, "spoiled", 1)),
      ).rejects.toThrow(/sold category|check constraint/);
      await client.query(insertOutcomeSql(), outcomeArgs(`sold-a-${fixture.suffix}`, fixture.listingId, commitmentId, purchaseId, "sold", 20));
      await client.query(insertOutcomeSql(), outcomeArgs(`sold-b-${fixture.suffix}`, fixture.listingId, commitmentId, purchaseId, "sold", 20));
      await expect(
        client.query(insertOutcomeSql(), outcomeArgs(`sold-c-${fixture.suffix}`, fixture.listingId, commitmentId, purchaseId, "sold", 0.001)),
      ).rejects.toThrow(/Sold outcomes/);
      const accounted = await client.query<{ grams: string; outcomes: string }>(
        `SELECT nyuma_listing_accounted_grams($1) AS grams,
                (SELECT count(*) FROM outcomes WHERE purchase_id = $2) AS outcomes`,
        [fixture.listingId, purchaseId],
      );
      expect(Number(accounted.rows[0]?.outcomes)).toBe(2);
      expect(Number(accounted.rows[0]?.grams)).toBe(40000);
      await expect(
        client.query(insertOutcomeSql(), outcomeArgs(`spoil-${fixture.suffix}`, fixture.listingId, null, null, "spoiled", 70)),
      ).rejects.toThrow(/Accounted quantity|Outcomes would exceed/);
      await expect(client.query("DELETE FROM outcomes WHERE id = $1", [`sold-a-${fixture.suffix}`])).rejects.toThrow(/cannot be deleted/);
      const precise = await client.query<{ quantity: string; price: string; kind: string }>(
        `${insertListingSql()} RETURNING quantity, asking_price_ksh_per_kg AS price, quantity_kind AS kind`,
        listingArgs(`precise-${fixture.suffix}`, fixture.ownerId, { quantity: "0.001", window: "3 hours", kind: "expected", price: "10.25" }),
      );
      expect(Number(precise.rows[0]?.quantity)).toBe(0.001);
      expect(Number(precise.rows[0]?.price)).toBe(10.25);
      expect(precise.rows[0]?.kind).toBe("expected");

      const overlapId = `overlap-${fixture.suffix}`;
      const overlapDemand = `overlap-d-${fixture.suffix}`;
      const overlapBuyer = await insertUser(client);
      await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'buyer')", [overlapBuyer]);
      await client.query(insertListingSql(), listingArgs(overlapId, fixture.ownerId, { quantity: 100, window: "Today", kind: "available" }));
      await client.query(insertDemandSql(), demandArgs(overlapDemand, overlapBuyer, { quantity: 100, window: "Today", commodity: "Watermelon" }));
      await client.query(insertOutcomeSql(), outcomeArgs(`overlap-spoil-${fixture.suffix}`, overlapId, null, null, "spoiled", 30));
      const overlapCommitment = `overlap-c-${fixture.suffix}`;
      await client.query(insertCommitmentSql(), commitmentArgs(overlapCommitment, overlapId, overlapDemand, 80, "confirmed"));
      await expect(
        client.query("SELECT nyuma_insert_purchase($1, $2, $3, 80, 'kg', 40, '2026-11-06')", [
          `overlap-p-${fixture.suffix}`,
          overlapCommitment,
          overlapId,
        ]),
      ).rejects.toThrow(/Accounted quantity/);
      const overlapAccount = await client.query<{ grams: string }>("SELECT nyuma_listing_accounted_grams($1) AS grams", [overlapId]);
      expect(Number(overlapAccount.rows[0]?.grams)).toBe(30000);
    } finally {
      await client.end();
      await fixture.close();
    }
  });

  it("keeps concurrent cancellation and purchase consistent without a permanent deadlock", async () => {
    for (let index = 0; index < 12; index += 1) {
      const fixture = await openTrade(100, 100);
      const commitmentId = `race-c-${fixture.suffix}`;
      const purchaseId = `race-p-${fixture.suffix}`;
      const setup = await connectClient(adminUrl);
      await setup.query(insertCommitmentSql(), commitmentArgs(commitmentId, fixture.listingId, fixture.demandId, 30, "confirmed"));
      await setup.end();
      const results = await Promise.all([
        attemptTransaction(adminUrl, async (client) => {
          await actAs(client, fixture.ownerId);
          await client.query("SELECT nyuma_set_commitment_status($1, 'cancelled')", [commitmentId]);
        }),
        attemptTransaction(adminUrl, async (client) => {
          await actAs(client, fixture.ownerId);
          await client.query("SELECT nyuma_insert_purchase($1, $2, $3, 10, 'kg', 40, '2026-11-06')", [
            purchaseId,
            commitmentId,
            fixture.listingId,
          ]);
        }),
      ]);
      expect(results.every((result) => !("code" in result) || (result.code !== "40P01" && result.code !== "40001"))).toBe(true);
      const client = await connectClient(adminUrl);
      try {
        const state = await client.query<{ status: string; purchases: string }>(
          `SELECT c.status, (SELECT count(*) FROM purchases p WHERE p.commitment_id = c.id) AS purchases
           FROM commitments c WHERE c.id = $1`,
          [commitmentId],
        );
        const status = state.rows[0]?.status;
        const purchases = Number(state.rows[0]?.purchases);
        const consistent = (status === "cancelled" && purchases === 0) || (status === "confirmed" && purchases === 1);
        expect(consistent).toBe(true);
        const purchased = await client.query<{ grams: string }>(
          "SELECT COALESCE(SUM(nyuma_grams(actual_quantity)), 0) AS grams FROM purchases WHERE commitment_id = $1",
          [commitmentId],
        );
        expect(Number(purchased.rows[0]?.grams)).toBeLessThanOrEqual(30000);
      } finally {
        await client.end();
        await fixture.close();
      }
    }
  }, 30000);
});

async function openTrade(listingQuantity: number, demandQuantity: number): Promise<{
  suffix: string;
  listingId: string;
  demandId: string;
  ownerId: string;
  close: () => Promise<void>;
}> {
  const client = await connectClient(adminUrl);
  const suffix = randomUUID();
  const ownerId = await insertUser(client);
  const buyerId = await insertUser(client);
  const listingId = `l-${suffix}`;
  const demandId = `d-${suffix}`;
  await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer'), ($2, 'buyer')", [ownerId, buyerId]);
  await client.query(insertListingSql(), listingArgs(listingId, ownerId, { quantity: listingQuantity, window: "Today", kind: "available" }));
  await client.query(insertDemandSql(), demandArgs(demandId, buyerId, { quantity: demandQuantity, window: "Today", commodity: "Watermelon" }));
  await client.end();
  return { suffix, listingId, demandId, ownerId, close: async () => undefined };
}

async function heldListing(listingId: string): Promise<number> {
  const client = await connectClient(adminUrl);
  try {
    const held = await client.query<{ grams: string }>("SELECT nyuma_listing_held_grams($1) AS grams", [listingId]);
    return Number(held.rows[0]?.grams);
  } finally {
    await client.end();
  }
}

async function insertUser(client: ClientBase): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id",
    [randomUUID()],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("User insert did not return an id.");
  return id;
}

async function actAs(client: ClientBase, userId: string): Promise<void> {
  const row = await client.query<{ auth_user_id: string }>(
    "SELECT auth_user_id::text AS auth_user_id FROM users WHERE id = $1",
    [userId],
  );
  const subject = row.rows[0]?.auth_user_id;
  if (!subject) throw new Error("The fixture account has no auth user id.");
  await bindToken(client, hmacSecret, subject);
}

async function attempt(
  url: string,
  sql: string,
  params: readonly unknown[],
): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  const client = await connectClient(url);
  try {
    await client.query("BEGIN");
    await client.query(sql, params as unknown[]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return failure(error);
  } finally {
    await client.end();
  }
}

async function attemptTransaction(
  url: string,
  work: (client: ClientBase) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  const client = await connectClient(url);
  try {
    await runTransaction(client, async (tx) => {
      await work(tx);
    });
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    await client.end();
  }
}

function failure(error: unknown): { ok: false; message: string; code?: string } {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  return { ok: false, message: error instanceof Error ? error.message : String(error), code };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function insertListingSql(): string {
  return `INSERT INTO listings (
    id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
  ) VALUES ($1, $2, 'Watermelon', $3, 'kg', $4, 'Kitui', $5, $6, $7)`;
}

function listingArgs(
  id: string,
  ownerId: string,
  input: { quantity: number | string; window: string; kind: string; price?: number | string | null; status?: string },
): unknown[] {
  return [id, ownerId, input.quantity, input.kind, input.window, input.price === undefined ? 40 : input.price, input.status ?? "open"];
}

function insertDemandSql(): string {
  return `INSERT INTO buyer_demands (
    id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
  ) VALUES ($1, $2, $3, $4, 'kg', 'Nairobi', $5, 42, 'open')`;
}

function demandArgs(id: string, buyerId: string, input: { quantity: number; window: string; commodity: string }): unknown[] {
  return [id, buyerId, input.commodity, input.quantity, input.window];
}

function insertCommitmentSql(): string {
  return `INSERT INTO commitments (
    id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
  ) VALUES ($1, $2, $3, $4, 'kg', 40, '2026-11-06', $5)`;
}

function commitmentArgs(id: string, listingId: string, demandId: string, quantity: number, status = "proposed"): unknown[] {
  return [id, listingId, demandId, quantity, status];
}

function insertOutcomeSql(): string {
  return `INSERT INTO outcomes (
    id, listing_id, commitment_id, purchase_id, category, quantity, quantity_unit, recorded_date, notes
  ) VALUES ($1, $2, $3, $4, $5, $6, 'kg', '2026-11-06', '')`;
}

function outcomeArgs(
  id: string,
  listingId: string,
  commitmentId: string | null,
  purchaseId: string | null,
  category: string,
  quantity: number,
): unknown[] {
  return [id, listingId, commitmentId, purchaseId, category, quantity];
}
