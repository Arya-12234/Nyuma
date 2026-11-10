import { randomUUID } from "node:crypto";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresIdentityStore, type IdentityStore } from "../src/auth/identity.js";
import { signTestToken, verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { createPostgresCoordinationStore, type CoordinationStore, type ListingRecord } from "../src/coordination/store.js";
import { connectClient } from "../src/db/client.js";
import { bindRequestToken } from "../src/db/session.js";
import { applyMigrations } from "../src/db/migrate.js";
import { start } from "../src/index.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const secret = new TextEncoder().encode("local-coordination-test-secret-not-a-project");
const issuer = "https://example-project.supabase.co/auth/v1";
const check: TokenCheck = { issuer, audience: "authenticated", keys: secret, algorithms: ["HS256"] };

let adminUrl = "";
let appUrl = "";
let operatorUrl = "";
let identities: IdentityStore | null = null;
let coordination: CoordinationStore | null = null;

interface Party {
  authUserId: string;
  accountId: string;
  token: string;
}

let traderA: Party;
let traderB: Party;
let buyerA: Party;
let buyerB: Party;
let unassigned: Party;

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Coordination integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    const password = randomUUID();
    const operatorPassword = randomUUID();
    await admin.query("DROP ROLE IF EXISTS nyuma_it_coordination");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_coordination_operator");
    await admin.query(`CREATE ROLE nyuma_it_coordination LOGIN PASSWORD '${password}'`);
    await admin.query("GRANT nyuma_app TO nyuma_it_coordination");
    await admin.query(`CREATE ROLE nyuma_it_coordination_operator LOGIN NOINHERIT PASSWORD '${operatorPassword}'`);
    await admin.query("GRANT nyuma_operator TO nyuma_it_coordination_operator");
    appUrl = roleUrl(adminUrl, "nyuma_it_coordination", password);
    operatorUrl = roleUrl(adminUrl, "nyuma_it_coordination_operator", operatorPassword);
    await installLocalHmac(admin, secret, "coordination-test");
  } finally {
    await admin.end();
  }
  identities = createPostgresIdentityStore(appUrl);
  coordination = createPostgresCoordinationStore(appUrl);
  traderA = await party(["trader"]);
  traderB = await party(["trader"]);
  buyerA = await party(["buyer"]);
  buyerB = await party(["buyer"]);
  unassigned = await party([]);
}, 60000);

afterAll(async () => {
  if (coordination) await coordination.close();
  if (identities) await identities.close();
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await retireLocalHmac(admin, "coordination-test");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_coordination");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_coordination_operator");
  } finally {
    await admin.end();
  }
});

describe("PostgreSQL coordination ownership, not a live Supabase project", () => {
  it("lets trader A create a listing and read it back as their own", async () => {
    const server = await listen();
    try {
      const created = await send(server, "POST", "/me/listings", traderA.token, draftListing());
      expect(created.status).toBe(201);
      const listing = readListing(created.body);
      expect(listing.ownerId).toBe(traderA.accountId);
      expect(listing.ownerId).not.toBe(traderA.authUserId);
      expect(listing.ownerId).not.toBe(traderB.accountId);
      expect(JSON.stringify(created.body)).not.toContain(traderA.authUserId);
      expect(listing.quantity).toBe(10.5);
      expect(listing.status).toBe("draft");
      const fetched = await send(server, "GET", `/me/listings/${listing.id}`, traderA.token);
      expect(fetched.status).toBe(200);
      expect(readListing(fetched.body).id).toBe(listing.id);
      const listed = await send(server, "GET", "/me/listings", traderA.token);
      expect(listed.status).toBe(200);
      expect(readListings(listed.body).some((row) => row.id === listing.id)).toBe(true);
      const hidden = await send(server, "GET", "/market/listings", traderA.token);
      expect(readMarket(hidden.body).some((row) => row.id === listing.id)).toBe(false);
      await send(server, "DELETE", `/me/listings/${listing.id}`, traderA.token);
    } finally {
      await close(server);
    }
  });

  it("returns 404 when trader B reads, updates, or deletes trader A's listing", async () => {
    const server = await listen();
    try {
      const created = await send(server, "POST", "/me/listings", traderA.token, draftListing({ quantity: 18 }));
      const listing = readListing(created.body);
      const read = await send(server, "GET", `/me/listings/${listing.id}`, traderB.token);
      const updated = await send(server, "PATCH", `/me/listings/${listing.id}`, traderB.token, { quantity: 1 });
      const removed = await send(server, "DELETE", `/me/listings/${listing.id}`, traderB.token);
      expect(read.status).toBe(404);
      expect(updated.status).toBe(404);
      expect(removed.status).toBe(404);
      expect(read.body).toEqual({ ok: false, error: "not-found" });
      const still = await send(server, "GET", `/me/listings/${listing.id}`, traderA.token);
      expect(readListing(still.body).quantity).toBe(18);
      const otherList = await send(server, "GET", "/me/listings", traderB.token);
      expect(readListings(otherList.body).some((row) => row.id === listing.id)).toBe(false);
      await send(server, "DELETE", `/me/listings/${listing.id}`, traderA.token);
    } finally {
      await close(server);
    }
  });

  it("rejects missing and malformed tokens", async () => {
    const server = await listen();
    try {
      const missing = await send(server, "POST", "/me/listings", undefined, draftListing());
      const market = await send(server, "GET", "/market/listings");
      const requirements = await send(server, "GET", "/market/requirements");
      const garbage = await send(server, "GET", "/me/listings", "not-a-token");
      expect(missing.status).toBe(401);
      expect(market.status).toBe(401);
      expect(requirements.status).toBe(401);
      expect(garbage.status).toBe(401);
      expect(missing.body).toEqual({ ok: false, error: "unauthenticated" });
    } finally {
      await close(server);
    }
  });

  it("requires the granted role and does not accept a client owner id", async () => {
    const server = await listen();
    try {
      const noRole = await send(server, "POST", "/me/listings", unassigned.token, draftListing());
      const buyerListing = await send(server, "POST", "/me/listings", buyerA.token, draftListing());
      const traderDemand = await send(server, "POST", "/me/buyer-requirements", traderA.token, openDemand());
      const before = await send(server, "GET", "/me/listings", traderB.token);
      const override = await send(server, "POST", "/me/listings", traderA.token, {
        ...draftListing(),
        ownerId: traderB.accountId,
        userId: traderB.authUserId,
      });
      const after = await send(server, "GET", "/me/listings", traderB.token);
      expect(noRole).toMatchObject({ status: 403, body: { ok: false, error: "role-not-granted" } });
      expect(buyerListing).toMatchObject({ status: 403, body: { ok: false, error: "role-not-granted" } });
      expect(traderDemand).toMatchObject({ status: 403, body: { ok: false, error: "role-not-granted" } });
      expect(override.status).toBe(400);
      expect(readListings(after.body)).toEqual(readListings(before.body));

      const created = await send(server, "POST", "/me/listings", traderA.token, draftListing());
      expect(readListing(created.body).ownerId).toBe(traderA.accountId);
      const reassigned = await send(server, "PATCH", `/me/listings/${readListing(created.body).id}`, traderA.token, {
        ownerId: traderB.accountId,
      });
      expect(reassigned.status).toBe(400);
      const owned = await send(server, "GET", `/me/listings/${readListing(created.body).id}`, traderA.token);
      expect(readListing(owned.body).ownerId).toBe(traderA.accountId);
      await send(server, "DELETE", `/me/listings/${readListing(created.body).id}`, traderA.token);
    } finally {
      await close(server);
    }
  });

  it("shows only live open listings and requirements on the market", async () => {
    const server = await listen();
    const open = draftListing({ status: "open", quantity: 7, quantityKind: "expected" });
    const draft = draftListing({ status: "draft" });
    const closed = draftListing({ status: "closed" });
    const withdrawn = draftListing({ status: "withdrawn" });
    try {
      const opened = readListing((await send(server, "POST", "/me/listings", traderA.token, open)).body);
      const drafted = readListing((await send(server, "POST", "/me/listings", traderA.token, draft)).body);
      const closing = readListing((await send(server, "POST", "/me/listings", traderA.token, closed)).body);
      const pulling = readListing((await send(server, "POST", "/me/listings", traderA.token, withdrawn)).body);
      const importedId = `demo-${randomUUID()}`;
      const admin = await connectClient(adminUrl);
      try {
        await admin.query(
          `INSERT INTO listings (
             id, owner_id, commodity, quantity, quantity_unit, quantity_kind, location, availability_window, status, origin
           ) VALUES ($1, $2, 'Mango', 3, 'kg', 'available', 'Nairobi', 'Today', 'open', 'demonstration-import')`,
          [importedId, traderA.accountId],
        );
      } finally {
        await admin.end();
      }
      const market = await send(server, "GET", "/market/listings?status=draft&ownerId=" + traderA.accountId, buyerA.token);
      const ids = readMarket(market.body).map((row) => row.id);
      expect(market.status).toBe(200);
      expect(ids).toContain(opened.id);
      expect(ids).not.toContain(drafted.id);
      expect(ids).not.toContain(closing.id);
      expect(ids).not.toContain(pulling.id);
      expect(ids).not.toContain(importedId);
      for (const row of readMarket(market.body)) {
        expect(row.status).toBe("open");
        expect(row).not.toHaveProperty("ownerId");
        expect(row).not.toHaveProperty("notes");
        expect(row).not.toHaveProperty("origin");
      }
      const visible = readMarket(market.body).find((row) => row.id === opened.id);
      expect(visible).toMatchObject({ quantityKind: "expected", quantity: 7, status: "open" });
      const ownImported = await send(server, "GET", `/me/listings/${importedId}`, traderA.token);
      expect(ownImported.status).toBe(200);
      expect(readListing(ownImported.body).ownerId).toBe(traderA.accountId);

      const openRequirement = readRequirement((await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand())).body);
      const closedRequirement = readRequirement(
        (await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand({ status: "closed" }))).body,
      );
      const withdrawnRequirement = readRequirement(
        (await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand({ status: "withdrawn" }))).body,
      );
      const requirements = await send(server, "GET", "/market/requirements", traderB.token);
      const requirementIds = readRequirements(requirements.body).map((row) => row.id);
      expect(requirementIds).toContain(openRequirement.id);
      expect(requirementIds).not.toContain(closedRequirement.id);
      expect(requirementIds).not.toContain(withdrawnRequirement.id);
      for (const row of readRequirements(requirements.body)) {
        expect(row.status).toBe("open");
        expect(row).not.toHaveProperty("buyerId");
      }

      await send(server, "DELETE", `/me/listings/${opened.id}`, traderA.token);
      await send(server, "DELETE", `/me/listings/${drafted.id}`, traderA.token);
      await send(server, "DELETE", `/me/listings/${closing.id}`, traderA.token);
      await send(server, "DELETE", `/me/listings/${pulling.id}`, traderA.token);
      await send(server, "DELETE", `/me/listings/${importedId}`, traderA.token);
      await send(server, "DELETE", `/me/buyer-requirements/${openRequirement.id}`, buyerA.token);
      await send(server, "DELETE", `/me/buyer-requirements/${closedRequirement.id}`, buyerA.token);
      await send(server, "DELETE", `/me/buyer-requirements/${withdrawnRequirement.id}`, buyerA.token);
    } finally {
      await close(server);
    }
  });

  it("keeps buyer requirements private to the owning buyer", async () => {
    const server = await listen();
    try {
      const created = await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand({ requestedQuantity: 6 }));
      const requirement = readRequirement(created.body);
      expect(created.status).toBe(201);
      expect(requirement.buyerId).toBe(buyerA.accountId);
      expect(requirement.buyerId).not.toBe(buyerA.authUserId);
      const foreignRead = await send(server, "GET", `/me/buyer-requirements/${requirement.id}`, buyerB.token);
      const foreignUpdate = await send(server, "PATCH", `/me/buyer-requirements/${requirement.id}`, buyerB.token, {
        requestedQuantity: 1,
      });
      const foreignDelete = await send(server, "DELETE", `/me/buyer-requirements/${requirement.id}`, buyerB.token);
      expect(foreignRead.status).toBe(404);
      expect(foreignUpdate.status).toBe(404);
      expect(foreignDelete.status).toBe(404);
      const still = await send(server, "GET", `/me/buyer-requirements/${requirement.id}`, buyerA.token);
      expect(readRequirement(still.body).requestedQuantity).toBe(6);
      const override = await send(server, "POST", "/me/buyer-requirements", buyerA.token, {
        ...openDemand(),
        buyerId: buyerB.accountId,
      });
      expect(override.status).toBe(400);
      const otherList = await send(server, "GET", "/me/buyer-requirements", buyerB.token);
      expect(readRequirements(otherList.body).some((row) => row.id === requirement.id)).toBe(false);
      await send(server, "DELETE", `/me/buyer-requirements/${requirement.id}`, buyerA.token);
    } finally {
      await close(server);
    }
  });

  it("rejects invalid input without changing the stored listing or requirement", async () => {
    const server = await listen();
    try {
      const created = await send(server, "POST", "/me/listings", traderA.token, draftListing({ quantity: 10, location: "Kitui" }));
      const listing = readListing(created.body);
      const badQuantity = await send(server, "PATCH", `/me/listings/${listing.id}`, traderA.token, { quantity: 1.2345 });
      const badLocation = await send(server, "PATCH", `/me/listings/${listing.id}`, traderA.token, { location: "Kitui'; DROP TABLE listings" });
      const badCommodity = await send(server, "PATCH", `/me/listings/${listing.id}`, traderA.token, { commodity: "Mango" });
      const badCreate = await send(server, "POST", "/me/listings", traderA.token, { ...draftListing(), quantity: -1 });
      expect(badQuantity.status).toBe(400);
      expect(badLocation.status).toBe(400);
      expect(badCommodity.status).toBe(400);
      expect(badCreate.status).toBe(400);
      const stored = await send(server, "GET", `/me/listings/${listing.id}`, traderA.token);
      expect(readListing(stored.body)).toMatchObject({ quantity: 10, location: "Kitui", commodity: "Watermelon", ownerId: traderA.accountId });
      const changed = await send(server, "PATCH", `/me/listings/${listing.id}`, traderA.token, { quantity: 12, status: "withdrawn" });
      expect(readListing(changed.body)).toMatchObject({ quantity: 12, status: "withdrawn" });
      const market = await send(server, "GET", "/market/listings", traderB.token);
      expect(readMarket(market.body).some((row) => row.id === listing.id)).toBe(false);
      await send(server, "DELETE", `/me/listings/${listing.id}`, traderA.token);

      const requirement = readRequirement((await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand({ requestedQuantity: 4 }))).body);
      const badDemand = await send(server, "PATCH", `/me/buyer-requirements/${requirement.id}`, buyerA.token, { requestedQuantity: 0 });
      expect(badDemand.status).toBe(400);
      const demandStored = await send(server, "GET", `/me/buyer-requirements/${requirement.id}`, buyerA.token);
      expect(readRequirement(demandStored.body).requestedQuantity).toBe(4);
      await send(server, "DELETE", `/me/buyer-requirements/${requirement.id}`, buyerA.token);
    } finally {
      await close(server);
    }
  });

  it("does not delete a listing that a commitment still references", async () => {
    const server = await listen();
    try {
      const listing = readListing(
        (await send(server, "POST", "/me/listings", traderA.token, draftListing({ quantity: 20, status: "open", availabilityWindow: "Today" }))).body,
      );
      const requirement = readRequirement(
        (await send(server, "POST", "/me/buyer-requirements", buyerA.token, openDemand({ requestedQuantity: 20, collectionWindow: "Today" }))).body,
      );
      const admin = await connectClient(adminUrl);
      try {
        await admin.query(
          `INSERT INTO commitments (
             id, listing_id, buyer_demand_id, agreed_quantity, quantity_unit, agreed_price_ksh_per_kg, expected_fulfilment_date, status
           ) VALUES ($1, $2, $3, 10, 'kg', 40, '2026-11-06', 'confirmed')`,
          [`rel-${randomUUID()}`, listing.id, requirement.id],
        );
      } finally {
        await admin.end();
      }
      const shrunk = await send(server, "PATCH", `/me/listings/${listing.id}`, traderA.token, { quantity: 5 });
      const removed = await send(server, "DELETE", `/me/listings/${listing.id}`, traderA.token);
      expect(shrunk).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
      expect(removed).toMatchObject({ status: 409, body: { ok: false, error: "relationship" } });
      const still = await send(server, "GET", `/me/listings/${listing.id}`, traderA.token);
      expect(readListing(still.body).quantity).toBe(20);
      const foreign = await send(server, "DELETE", `/me/listings/${listing.id}`, traderB.token);
      expect(foreign.status).toBe(404);
    } finally {
      await close(server);
    }
  });
});

async function party(roles: string[]): Promise<Party> {
  const authUserId = randomUUID();
  const token = await signTestToken(secret, { subject: authUserId, issuer, audience: "authenticated", expiresIn: "30m" });
  const account = await bindRequestToken(token, () => requireIdentities().bootstrap(authUserId));
  if (roles.length > 0) await grant(authUserId, account.id, roles);
  return { authUserId, accountId: account.id, token };
}

async function grant(authUserId: string, accountId: string, roles: string[]): Promise<void> {
  const app = await connectClient(appUrl);
  try {
    await bindToken(app, secret, authUserId);
    await app.query("SELECT nyuma_submit_role_requests($1, $2::text[])", [authUserId, roles]);
  } finally {
    await app.end();
  }
  const operator = await connectClient(operatorUrl);
  try {
    await operator.query("SET ROLE nyuma_operator");
    const pending = await operator.query<{ id: string }>(
      "SELECT id FROM role_requests WHERE user_id = $1 AND status = 'pending'",
      [accountId],
    );
    for (const row of pending.rows) {
      await operator.query("SELECT nyuma_approve_role_request($1, NULL)", [row.id]);
    }
  } finally {
    await operator.end();
  }
}

function requireIdentities(): IdentityStore {
  if (!identities || !coordination) throw new Error("The coordination stores were not opened.");
  return identities;
}

async function listen(): Promise<Server> {
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
    coordination,
    auth: null,
    verifyToken: (token) => verifyAccessToken(token, check),
  });
}

function roleUrl(base: string, username: string, password: string): string {
  const parsed = new URL(base);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

function draftListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commodity: "Watermelon",
    quantity: 10.5,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40.25,
    status: "draft",
    ...overrides,
  };
}

function openDemand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commodity: "Watermelon",
    requestedQuantity: 8,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
    ...overrides,
  };
}

function readListing(body: unknown): ListingRecord {
  return (body as { listing: ListingRecord }).listing;
}

function readListings(body: unknown): ListingRecord[] {
  return (body as { listings: ListingRecord[] }).listings;
}

function readMarket(body: unknown): Array<{ id: string; status: string; quantityKind?: string; quantity?: number }> {
  return (body as { listings: Array<{ id: string; status: string; quantityKind?: string; quantity?: number }> }).listings;
}

function readRequirement(body: unknown): { id: string; buyerId: string; requestedQuantity: number; status: string } {
  return (body as { requirement: { id: string; buyerId: string; requestedQuantity: number; status: string } }).requirement;
}

function readRequirements(body: unknown): Array<{ id: string; status: string; buyerId?: string }> {
  return (body as { requirements: Array<{ id: string; status: string; buyerId?: string }> }).requirements;
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

function send(
  server: Server,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = request(`${addressOf(server)}${path}`, { method, headers }, (response) => {
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
