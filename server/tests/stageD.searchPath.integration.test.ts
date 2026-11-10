import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const hmacSecret = new TextEncoder().encode("local-stage-d-search-path-secret");

let adminUrl = "";
let apiUrl = "";

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Search-path integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    await installLocalHmac(admin, hmacSecret, "stage-d-search-path");
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
    await retireLocalHmac(admin, "stage-d-search-path");
  } finally {
    await admin.end();
  }
});

describe("Stage D search path", () => {
  it("ignores a temporary commitments table when the API records another agreement", async () => {
    const admin = await connectClient(adminUrl);
    const api = await connectClient(apiUrl);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    try {
      const farmerSub = randomUUID();
      const buyerSub = randomUUID();
      const farmer = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [farmerSub]);
      const buyer = await admin.query<{ id: string }>("INSERT INTO users (auth_user_id) VALUES ($1) RETURNING id", [buyerSub]);
      const farmerId = farmer.rows[0]?.id;
      const buyerId = buyer.rows[0]?.id;
      if (!farmerId || !buyerId) throw new Error("Fixture accounts were not created.");
      await admin.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'farmer'), ($2, 'buyer')", [farmerId, buyerId]);
      const listingId = `l-shadow-${suffix}`;
      const demandId = `d-shadow-${suffix}`;
      await admin.query(
        `INSERT INTO listings (
           id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, asking_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 10, 'kg', 'available', 'Kitui', 'Today', 40, 'open')`,
        [listingId, farmerId],
      );
      await admin.query(
        `INSERT INTO buyer_demands (
           id, buyer_id, commodity, requested_quantity, quantity_unit, preferred_location, collection_window, indicative_price_ksh_per_kg, status
         ) VALUES ($1, $2, 'Watermelon', 10, 'kg', 'Nairobi', 'Today', 42, 'open')`,
        [demandId, buyerId],
      );
      await admin.query(
        `INSERT INTO commitments (
           id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
         ) VALUES ($1, $2, $3, 10, 'kg', 40, '2026-11-06', 'proposed')`,
        [`c-shadow-${suffix}`, listingId, demandId],
      );

      await bindToken(api, hmacSecret, farmerSub);
      await expect(api.query("CREATE TABLE public.shadow_commitments (id text)")).rejects.toThrow(/permission denied/);
      await api.query(
        `CREATE TEMP TABLE commitments (
           id text,
           listing_id text,
           buyer_demand_id text,
           status text,
           agreed_quantity numeric
         )`,
      );
      await api.query("GRANT SELECT ON TABLE commitments TO nyuma_fn_constraint");
      await expect(api.query(
        "SELECT nyuma_insert_commitment($1, $2, $3, 1, 40, '2026-11-06', 'proposed')",
        [`c-extra-${suffix}`, listingId, demandId],
      )).rejects.toThrow(/quantity/);

      const remaining = await admin.query<{ n: string; held: string }>(
        `SELECT count(*) AS n, public.nyuma_listing_held_grams($1) AS held
         FROM public.commitments WHERE listing_id = $1`,
        [listingId],
      );
      expect(remaining.rows[0]?.n).toBe("1");
      expect(Number(remaining.rows[0]?.held)).toBe(10000);
    } finally {
      await api.query("ROLLBACK").catch(() => undefined);
      await admin.end();
      await api.end();
    }
  });

  it("puts pg_temp last on every public security definer and leaves row security off", async () => {
    const admin = await connectClient(adminUrl);
    try {
      const paths = await admin.query<{ proname: string; path: string }>(
        `SELECT p.proname, array_to_string(p.proconfig, ',') AS path
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
         ORDER BY p.proname`,
      );
      expect(paths.rows.length).toBeGreaterThan(30);
      expect(paths.rows.every((row) => row.path.endsWith("pg_temp"))).toBe(true);
      expect(paths.rows.some((row) => row.path.startsWith("search_path=pg_temp"))).toBe(false);
      const security = await admin.query<{ enabled: boolean }>(
        `SELECT bool_or(c.relrowsecurity OR c.relforcerowsecurity) AS enabled
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );
      expect(security.rows[0]?.enabled).toBe(false);
    } finally {
      await admin.end();
    }
  });
});
