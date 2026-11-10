import { randomUUID } from "node:crypto";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresIdentityStore, type IdentityStore } from "../src/auth/identity.js";
import { signTestToken, verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { createPostgresCoordinationStore, type CoordinationStore } from "../src/coordination/store.js";
import { connectClient } from "../src/db/client.js";
import { bindRequestToken } from "../src/db/session.js";
import { applyMigrations } from "../src/db/migrate.js";
import { start } from "../src/index.js";
import { bindToken, installLocalHmac, retireLocalHmac } from "./localVerifier.js";

const databaseUrl = process.env.DATABASE_URL;
const secret = new TextEncoder().encode("local-activity-test-secret-not-a-project");
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

let farmer: Party;
let trader: Party;
let buyer: Party;
let otherBuyer: Party;
let outsider: Party;

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required. Activity integration was not skipped and was not run.");
  }
  const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test" });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  adminUrl = config.databaseUrl;
  await applyMigrations(adminUrl);
  const admin = await connectClient(adminUrl);
  try {
    const password = randomUUID();
    const operatorPassword = randomUUID();
    await admin.query("DROP ROLE IF EXISTS nyuma_it_activity");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_activity_operator");
    await admin.query(`CREATE ROLE nyuma_it_activity LOGIN PASSWORD '${password}'`);
    await admin.query("GRANT nyuma_app TO nyuma_it_activity");
    await admin.query(`CREATE ROLE nyuma_it_activity_operator LOGIN NOINHERIT PASSWORD '${operatorPassword}'`);
    await admin.query("GRANT nyuma_operator TO nyuma_it_activity_operator");
    appUrl = roleUrl(adminUrl, "nyuma_it_activity", password);
    operatorUrl = roleUrl(adminUrl, "nyuma_it_activity_operator", operatorPassword);
    await installLocalHmac(admin, secret, "activity-test");
  } finally {
    await admin.end();
  }
  identities = createPostgresIdentityStore(appUrl);
  coordination = createPostgresCoordinationStore(appUrl);
  farmer = await party(["farmer"]);
  trader = await party(["trader"]);
  buyer = await party(["buyer"]);
  otherBuyer = await party(["buyer"]);
  outsider = await party([]);
}, 60000);

afterAll(async () => {
  if (coordination) await coordination.close();
  if (identities) await identities.close();
  if (!adminUrl) return;
  const admin = await connectClient(adminUrl);
  try {
    await retireLocalHmac(admin, "activity-test");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_activity");
    await admin.query("DROP ROLE IF EXISTS nyuma_it_activity_operator");
  } finally {
    await admin.end();
  }
});

describe("PostgreSQL agreements, purchases, and outcomes", () => {
  it("lets a farmer and a buyer share an agreement the other buyer cannot see", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, farmer.token, 20);
      const requirement = await openRequirement(server, buyer.token, 8);
      const created = await send(server, "POST", "/me/agreements", farmer.token, agreementBody(listing.id, requirement.id, 6, "proposed"));
      expect(created.status).toBe(201);
      const agreement = readAgreement(created.body);
      expect(agreement).toMatchObject({
        listingId: listing.id,
        buyerDemandId: requirement.id,
        agreedQuantity: 6,
        status: "proposed",
        quantityUnit: "kg",
      });
      expect(JSON.stringify(created.body)).not.toContain(farmer.authUserId);
      expect(JSON.stringify(created.body)).not.toContain("ownerId");
      const farmerRead = await send(server, "GET", `/me/agreements/${agreement.id}`, farmer.token);
      const buyerRead = await send(server, "GET", `/me/agreements/${agreement.id}`, buyer.token);
      const hidden = await send(server, "GET", `/me/agreements/${agreement.id}`, otherBuyer.token);
      const traderHidden = await send(server, "GET", `/me/agreements/${agreement.id}`, trader.token);
      expect(farmerRead.status).toBe(200);
      expect(buyerRead.status).toBe(200);
      expect(hidden.status).toBe(404);
      expect(traderHidden.status).toBe(404);
      const buyerList = await send(server, "GET", "/me/agreements", buyer.token);
      const otherList = await send(server, "GET", "/me/agreements", otherBuyer.token);
      expect(readAgreements(buyerList.body).some((row) => row.id === agreement.id)).toBe(true);
      expect(readAgreements(otherList.body).some((row) => row.id === agreement.id)).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("lets a trader confirm and a buyer purchase, and rejects another account", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, trader.token, 12);
      const requirement = await openRequirement(server, buyer.token, 10);
      const created = await send(server, "POST", "/me/agreements", trader.token, agreementBody(listing.id, requirement.id, 5, "confirmed"));
      const agreement = readAgreement(created.body);
      const buyerPurchase = await send(server, "POST", "/me/purchases", buyer.token, purchaseBody(agreement.id, 3));
      expect(buyerPurchase.status).toBe(201);
      const purchase = readPurchase(buyerPurchase.body);
      expect(purchase).toMatchObject({ commitmentId: agreement.id, listingId: listing.id, actualQuantity: 3 });
      const traderRead = await send(server, "GET", `/me/purchases/${purchase.id}`, trader.token);
      const outsiderRead = await send(server, "GET", `/me/purchases/${purchase.id}`, otherBuyer.token);
      expect(traderRead.status).toBe(200);
      expect(outsiderRead.status).toBe(404);
      const listed = await send(server, "GET", "/me/purchases", trader.token);
      expect(readPurchases(listed.body).some((row) => row.id === purchase.id)).toBe(true);
      const notMine = await send(server, "GET", "/me/purchases", otherBuyer.token);
      expect(readPurchases(notMine.body).some((row) => row.id === purchase.id)).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("records an outcome for the listing owner and shows the buyer only the sold link without notes", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, farmer.token, 15);
      const requirement = await openRequirement(server, buyer.token, 10);
      const agreement = readAgreement(
        (await send(server, "POST", "/me/agreements", buyer.token, agreementBody(listing.id, requirement.id, 4, "confirmed"))).body,
      );
      const purchase = readPurchase((await send(server, "POST", "/me/purchases", farmer.token, purchaseBody(agreement.id, 4))).body);
      const sold = await send(server, "POST", "/me/outcomes", farmer.token, outcomeBody(listing.id, "sold", 4, purchase.id, "Collected in Kitui"));
      expect(sold.status).toBe(201);
      const outcome = readOutcome(sold.body);
      expect(outcome).toMatchObject({
        listingId: listing.id,
        commitmentId: agreement.id,
        purchaseId: purchase.id,
        category: "sold",
        quantity: 4,
        notes: "Collected in Kitui",
      });
      const spoiled = await send(server, "POST", "/me/outcomes", farmer.token, outcomeBody(listing.id, "spoiled", 1, null, "Heat"));
      expect(spoiled.status).toBe(201);
      const buyerSold = await send(server, "GET", `/me/outcomes/${outcome.id}`, buyer.token);
      const buyerSpoiled = await send(server, "GET", `/me/outcomes/${readOutcome(spoiled.body).id}`, buyer.token);
      const otherSold = await send(server, "GET", `/me/outcomes/${outcome.id}`, otherBuyer.token);
      expect(buyerSold.status).toBe(200);
      expect(readOutcome(buyerSold.body).notes).toBeNull();
      expect(buyerSpoiled.status).toBe(404);
      expect(otherSold.status).toBe(404);
      const buyerList = await send(server, "GET", "/me/outcomes", buyer.token);
      expect(readOutcomes(buyerList.body).map((row) => row.id)).toContain(outcome.id);
      expect(readOutcomes(buyerList.body).some((row) => row.category === "spoiled" && row.listingId === listing.id)).toBe(false);
      const duplicate = await send(server, "POST", "/me/outcomes", farmer.token, outcomeBody(listing.id, "spoiled", 1, null, "Heat"));
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toEqual({ ok: false, error: "conflict" });
    } finally {
      await close(server);
    }
  });

  it("rejects role mistakes, counterparty changes, bad links, and illegal status moves", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, farmer.token, 20);
      const requirement = await openRequirement(server, buyer.token, 8);
      const proposed = readAgreement(
        (await send(server, "POST", "/me/agreements", farmer.token, agreementBody(listing.id, requirement.id, 2, "proposed"))).body,
      );
      const noRole = await send(server, "POST", "/me/agreements", outsider.token, agreementBody(listing.id, requirement.id, 1, "confirmed"));
      const buyerOutcome = await send(server, "POST", "/me/outcomes", buyer.token, outcomeBody(listing.id, "spoiled", 1, null, ""));
      const otherAgreement = await send(server, "POST", "/me/agreements", otherBuyer.token, agreementBody(listing.id, requirement.id, 1, "confirmed"));
      const otherListing = await openListing(server, trader.token, 9);
      const crossed = await send(server, "POST", "/me/agreements", trader.token, agreementBody(listing.id, requirement.id, 1, "confirmed"));
      const missing = await send(server, "POST", "/me/agreements", farmer.token, agreementBody("missing-listing", requirement.id, 1, "confirmed"));
      const ownerChange = await send(server, "PATCH", `/me/agreements/${proposed.id}`, farmer.token, {
        status: "confirmed",
        listingId: otherListing.id,
      });
      const skipped = await send(server, "PATCH", `/me/agreements/${proposed.id}`, buyer.token, { status: "fulfilled" });
      const tooSoon = await send(server, "POST", "/me/purchases", farmer.token, purchaseBody(proposed.id, 1));
      const confirmed = await send(server, "PATCH", `/me/agreements/${proposed.id}`, buyer.token, { status: "confirmed" });
      const purchaseChange = await send(server, "POST", "/me/purchases", farmer.token, {
        ...purchaseBody(proposed.id, 1),
        listingId: otherListing.id,
      });
      expect(noRole).toMatchObject({ status: 403, body: { ok: false, error: "role-not-granted" } });
      expect(buyerOutcome).toMatchObject({ status: 403, body: { ok: false, error: "role-not-granted" } });
      expect(otherAgreement.status).toBe(404);
      expect(crossed.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(ownerChange.status).toBe(400);
      expect(skipped).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
      expect(tooSoon).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
      expect(confirmed.status).toBe(200);
      expect(readAgreement(confirmed.body).status).toBe("confirmed");
      expect(purchaseChange.status).toBe(400);
      const early = await send(server, "POST", "/me/purchases", trader.token, purchaseBody(proposed.id, 1));
      expect(early.status).toBe(404);
    } finally {
      await close(server);
    }
  });

  it("rolls back a purchase that exceeds the agreement and keeps the earlier purchase", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, farmer.token, 20);
      const requirement = await openRequirement(server, buyer.token, 10);
      const agreement = readAgreement(
        (await send(server, "POST", "/me/agreements", farmer.token, agreementBody(listing.id, requirement.id, 5, "confirmed"))).body,
      );
      const first = await send(server, "POST", "/me/purchases", buyer.token, purchaseBody(agreement.id, 3));
      expect(first.status).toBe(201);
      const overflow = await send(server, "POST", "/me/purchases", farmer.token, purchaseBody(agreement.id, 3));
      expect(overflow).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
      const purchases = readPurchases((await send(server, "GET", "/me/purchases", buyer.token)).body).filter(
        (row) => row.commitmentId === agreement.id,
      );
      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.actualQuantity).toBe(3);
      const cancel = await send(server, "PATCH", `/me/agreements/${agreement.id}`, farmer.token, { status: "cancelled" });
      expect(cancel).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
      const still = await send(server, "GET", `/me/agreements/${agreement.id}`, buyer.token);
      expect(readAgreement(still.body).status).toBe("confirmed");
    } finally {
      await close(server);
    }
  });

  it("rejects a suspended account and a missing or expired token", async () => {
    const server = await listen();
    try {
      const listing = await openListing(server, farmer.token, 10);
      const requirement = await openRequirement(server, buyer.token, 4);
      await setStatus(farmer.accountId, "suspended");
      const suspended = await send(server, "POST", "/me/agreements", farmer.token, agreementBody(listing.id, requirement.id, 1, "confirmed"));
      await setStatus(farmer.accountId, "active");
      const missing = await send(server, "GET", "/me/agreements");
      const expiredToken = await signTestToken(secret, {
        subject: farmer.authUserId,
        issuer,
        audience: "authenticated",
        expiresIn: Math.floor(Date.now() / 1000) - 60,
      });
      const expired = await send(server, "GET", "/me/purchases", expiredToken);
      expect(suspended).toMatchObject({ status: 403, body: { ok: false, error: "account-disabled" } });
      expect(missing).toMatchObject({ status: 401, body: { ok: false, error: "unauthenticated" } });
      expect(expired).toMatchObject({ status: 401, body: { ok: false, error: "unauthenticated" } });
      const restored = await send(server, "GET", "/me/agreements", farmer.token);
      expect(restored.status).toBe(200);
    } finally {
      await setStatus(farmer.accountId, "active");
      await close(server);
    }
  });
});

async function openListing(server: Server, token: string, quantity: number): Promise<{ id: string }> {
  const created = await send(server, "POST", "/me/listings", token, {
    commodity: "Watermelon",
    quantity,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
  });
  if (created.status !== 201) throw new Error(`listing was not created: ${created.status}`);
  return { id: (created.body as { listing: { id: string } }).listing.id };
}

async function openRequirement(server: Server, token: string, quantity: number): Promise<{ id: string }> {
  const created = await send(server, "POST", "/me/buyer-requirements", token, {
    commodity: "Watermelon",
    requestedQuantity: quantity,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
  });
  if (created.status !== 201) throw new Error(`requirement was not created: ${created.status}`);
  return { id: (created.body as { requirement: { id: string } }).requirement.id };
}

function agreementBody(listingId: string, buyerDemandId: string, agreedQuantity: number, status: string): Record<string, unknown> {
  return {
    listingId,
    buyerDemandId,
    agreedQuantity,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-06",
    status,
  };
}

function purchaseBody(commitmentId: string, actualQuantity: number): Record<string, unknown> {
  return {
    commitmentId,
    actualQuantity,
    quantityUnit: "kg",
    actualPriceKshPerKg: 41,
    purchaseDate: "2026-11-06",
  };
}

function outcomeBody(
  listingId: string,
  category: string,
  quantity: number,
  purchaseId: string | null,
  notes: string,
): Record<string, unknown> {
  return {
    listingId,
    category,
    quantity,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes,
    purchaseId,
  };
}

async function setStatus(accountId: string, status: string): Promise<void> {
  const client = await connectClient(adminUrl);
  try {
    await client.query("UPDATE users SET status = $2 WHERE id = $1", [accountId, status]);
  } finally {
    await client.end();
  }
}

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
  if (!identities || !coordination) throw new Error("The activity stores were not opened.");
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

function readAgreement(body: unknown): { id: string; listingId: string; buyerDemandId: string; agreedQuantity: number; status: string; quantityUnit: string } {
  return (body as { agreement: { id: string; listingId: string; buyerDemandId: string; agreedQuantity: number; status: string; quantityUnit: string } }).agreement;
}

function readAgreements(body: unknown): Array<{ id: string }> {
  return (body as { agreements: Array<{ id: string }> }).agreements;
}

function readPurchase(body: unknown): { id: string; commitmentId: string; listingId: string; actualQuantity: number } {
  return (body as { purchase: { id: string; commitmentId: string; listingId: string; actualQuantity: number } }).purchase;
}

function readPurchases(body: unknown): Array<{ id: string; commitmentId: string; actualQuantity: number }> {
  return (body as { purchases: Array<{ id: string; commitmentId: string; actualQuantity: number }> }).purchases;
}

function readOutcome(body: unknown): {
  id: string;
  listingId: string;
  commitmentId: string | null;
  purchaseId: string | null;
  category: string;
  quantity: number;
  notes: string | null;
} {
  return (body as { outcome: { id: string; listingId: string; commitmentId: string | null; purchaseId: string | null; category: string; quantity: number; notes: string | null } }).outcome;
}

function readOutcomes(body: unknown): Array<{ id: string; category: string; listingId: string }> {
  return (body as { outcomes: Array<{ id: string; category: string; listingId: string }> }).outcomes;
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

function send(server: Server, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: unknown }> {
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
