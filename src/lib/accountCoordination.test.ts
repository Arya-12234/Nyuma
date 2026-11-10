import { describe, expect, it } from "vitest";
import { COORDINATION_STORAGE_KEY } from "../domain/coordinationDocument";
import {
  createLocalCoordinationRepository,
  createSequentialIdGenerator,
  createSteppedClock,
  type CoordinationRepository,
} from "../domain/coordinationRepository";
import type { CoordinationKeyValueStore } from "../domain/coordinationDocument";
import type { Listing } from "../domain/records";
import { signIn } from "./auth";
import type { SessionUser } from "./auth";
import {
  loadOwnedListings,
  loadWorkspaceRecords,
  outcomeNoteText,
  participantLabel,
  reduceWorkspaceLoad,
  saveAccountAgreement,
  saveAccountListing,
  saveAccountOutcome,
  saveAccountPurchase,
  saveAccountRequirement,
  updateAccountAgreementStatus,
} from "./accountCoordination";
import { NyumaApiError, type ApiAgreement, type ApiListing, type ApiOutcome, type ApiPurchase, type ApiRequirement, type NyumaApi } from "./nyumaApi";
import { SAMPLE_USERS } from "./sampleUsers";
import { SCENARIO_STORAGE_KEY } from "./scenarioStorage";

const SAMPLE_DOCUMENT = '{"sample":"watermelon"}';
const SCENARIO_DOCUMENT = '{"scenario":"practice"}';

const FARMER_A = "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3";
const FARMER_B = "9b3d2c8f-2d3e-4f60-b7c8-d9e0f1a2b3c4";
const BUYER_A = "7c4e3d9a-3e4f-4061-c8d9-e0f1a2b3c4d5";

const listingForm = {
  commodity: "Watermelon",
  quantity: "10.5",
  quantityKind: "available",
  location: "Kitui",
  availabilityWindow: "3 hours",
  askingPrice: "40.25",
};

const requirementForm = {
  commodity: "Watermelon",
  quantity: "8",
  location: "Nairobi",
  collectionWindow: "Today",
  indicativePrice: "42",
};

describe("account coordination storage", () => {
  it("keeps a sample user on the browser repository", async () => {
    const store = memoryStore(false);
    const repository = localRepository(store);
    const user = sample("farmer@nyuma.ke");
    const api = trackingApi();
    const loaded = await loadWorkspaceRecords({
      user,
      token: "should-not-be-sent",
      api: api.client,
      sampleRepository: repository,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe("sample");
    expect(api.calls).toEqual([]);
    const saved = await repository.createListing(draftListing(user.id));
    expect(saved.ok).toBe(true);
    const again = await loadOwnedListings({ user, token: null, api: null, sampleRepository: repository });
    expect(again.ok && again.listings.map((listing) => listing.ownerId)).toEqual([user.id]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toContain(user.id);
    expect(store.raw[SCENARIO_STORAGE_KEY]).toBe(SCENARIO_DOCUMENT);
  });

  it("does not read the shared coordination document for a real account", async () => {
    const store = memoryStore();
    const loaded = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: trackingApi([ownedListing(FARMER_A)]).client,
      sampleRepository: throwingRepository(store),
    });
    expect(loaded.ok).toBe(true);
    expect(store.reads).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toBe(SAMPLE_DOCUMENT);
    expect(store.raw[SCENARIO_STORAGE_KEY]).toBe(SCENARIO_DOCUMENT);
  });

  it("does not give an administrator another account's records or the sample document", async () => {
    const store = memoryStore();
    const api = trackingApi();
    const loaded = await loadWorkspaceRecords({
      user: account("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "administrator"),
      token: "admin-token",
      api: api.client,
      sampleRepository: throwingRepository(store),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe("account");
    expect(loaded.records.listings).toEqual([]);
    expect(loaded.records.commitments).toEqual([]);
    expect(loaded.records.purchases).toEqual([]);
    expect(loaded.records.outcomes).toEqual([]);
    expect(store.reads).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toBe(SAMPLE_DOCUMENT);
    expect(api.calls.map((call) => call.name)).toEqual([
      "listListings",
      "listMarketListings",
      "listRequirements",
      "listMarketRequirements",
      "listAgreements",
      "listPurchases",
      "listOutcomes",
    ]);
  });

  it("does not carry a real account response into the sample workspace", async () => {
    const store = memoryStore(false);
    const repository = localRepository(store);
    const api = trackingApi([ownedListing(FARMER_A, "listing-real")]);
    const real = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: api.client,
      sampleRepository: throwingRepository(store),
    });
    const sampleLoad = await loadWorkspaceRecords({
      user: sample("farmer@nyuma.ke"),
      token: "token-a",
      api: api.client,
      sampleRepository: repository,
    });
    expect(real.ok).toBe(true);
    if (!real.ok || !sampleLoad.ok) return;
    expect(real.records.listings.map((listing) => listing.id)).toEqual(["listing-real"]);
    expect(sampleLoad.source).toBe("sample");
    expect(sampleLoad.records.listings).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY] ?? "").not.toContain("listing-real");
    expect(store.raw[SCENARIO_STORAGE_KEY]).toBe(SCENARIO_DOCUMENT);
  });

  it("creates and updates a real listing through the API", async () => {
    const api = trackingApi([ownedListing(FARMER_A)]);
    const user = account(FARMER_A, "farmer");
    const created = await saveAccountListing({
      user,
      token: "token-a",
      api: api.client,
      existing: null,
      values: listingForm,
      status: "draft",
    });
    expect(created.ok).toBe(true);
    const existing = created.ok ? created.value : ownedDomain(FARMER_A);
    const updated = await saveAccountListing({
      user,
      token: "token-a",
      api: api.client,
      existing,
      values: { ...listingForm, quantity: "12" },
      status: "open",
    });
    expect(updated.ok).toBe(true);
    expect(api.calls.map((call) => call.name)).toEqual(["createListing", "updateListing"]);
    expect(JSON.stringify(api.calls)).not.toContain("ownerId");
    expect(JSON.stringify(api.calls)).not.toContain(FARMER_A);
    expect(api.calls[1]?.patch).toMatchObject({ quantity: 12, status: "open" });
  });

  it("creates and updates a real buyer requirement through the API", async () => {
    const api = trackingApi([], [ownedRequirement(BUYER_A)]);
    const user = account(BUYER_A, "buyer");
    const created = await saveAccountRequirement({
      user,
      token: "token-buyer",
      api: api.client,
      existing: null,
      values: requirementForm,
      status: "open",
    });
    expect(created.ok).toBe(true);
    const existing = created.ok ? created.value : null;
    if (!existing) return;
    const updated = await saveAccountRequirement({
      user,
      token: "token-buyer",
      api: api.client,
      existing,
      values: { ...requirementForm, quantity: "9" },
      status: "withdrawn",
    });
    expect(updated.ok).toBe(true);
    expect(api.calls.map((call) => call.name)).toEqual(["createRequirement", "updateRequirement"]);
    expect(JSON.stringify(api.calls)).not.toContain("buyerId");
    expect(api.calls[1]?.patch).toMatchObject({ requestedQuantity: 9, status: "withdrawn" });
  });

  it("loads published records from the market endpoints", async () => {
    const api = trackingApi([ownedListing(FARMER_A)], [], [marketOwnedListing()], [marketRequirement()]);
    const loaded = await loadWorkspaceRecords({
      user: account(FARMER_A, "trader"),
      token: "token-a",
      api: api.client,
      sampleRepository: null,
    });
    expect(api.calls.map((call) => call.name)).toEqual([
      "listListings",
      "listMarketListings",
      "listRequirements",
      "listMarketRequirements",
      "listAgreements",
      "listPurchases",
      "listOutcomes",
    ]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.records.listings.map((listing) => listing.id)).toEqual(["listing-a", "listing-market"]);
    expect(loaded.records.demands.map((demand) => demand.buyerId)).toEqual(["published"]);
    expect(loaded.records.commitments).toEqual([]);
    expect(loaded.records.purchases).toEqual([]);
    expect(loaded.records.outcomes).toEqual([]);
  });

  it("does not fall back to browser storage when the API fails", async () => {
    const store = memoryStore();
    const api = trackingApi();
    api.fail = new NyumaApiError(503, "request-failed");
    const loaded = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: api.client,
      sampleRepository: throwingRepository(store),
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe("request-failed");
    expect(store.reads).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toBe(SAMPLE_DOCUMENT);
  });

  it("clears the previous account when the account changes and after logout", async () => {
    const first = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: trackingApi([ownedListing(FARMER_A)]).client,
      sampleRepository: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cleared = reduceWorkspaceLoad({ phase: "ready", listings: first.records.listings }, { type: "reset" });
    expect(cleared).toEqual({ phase: "loading" });
    const second = await loadWorkspaceRecords({
      user: account(FARMER_B, "farmer"),
      token: "token-b",
      api: trackingApi([ownedListing(FARMER_B, "listing-b")]).client,
      sampleRepository: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.records.listings.map((listing) => listing.ownerId)).toEqual([FARMER_B]);
    const signedOut = reduceWorkspaceLoad({ phase: "ready", listings: second.records.listings }, { type: "reset" });
    expect(signedOut).toEqual({ phase: "loading" });
    expect("listings" in signedOut).toBe(false);
  });

  it("leaves sample records intact when a real account signs out", async () => {
    const store = memoryStore(false);
    const repository = localRepository(store);
    const sampleUser = sample("farmer@nyuma.ke");
    await repository.createListing(draftListing(sampleUser.id));
    const before = store.raw[COORDINATION_STORAGE_KEY];
    await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: trackingApi([ownedListing(FARMER_A)]).client,
      sampleRepository: null,
    });
    const signedOut = reduceWorkspaceLoad({ phase: "ready", listings: [ownedDomain(FARMER_A)] }, { type: "reset" });
    expect(signedOut.phase).toBe("loading");
    expect(store.raw[COORDINATION_STORAGE_KEY]).toBe(before);
    expect(store.raw[SCENARIO_STORAGE_KEY]).toBe(SCENARIO_DOCUMENT);
    const restored = await loadOwnedListings({ user: sampleUser, token: null, api: null, sampleRepository: repository });
    expect(restored.ok && restored.listings).toHaveLength(1);
  });

  it("does not keep another account's records after a failed request", () => {
    const previous = reduceWorkspaceLoad(
      { phase: "ready", listings: [ownedDomain(FARMER_A)] },
      { type: "error", message: "Nyuma could not complete that request." },
    );
    expect(previous).toEqual({ phase: "error", message: "Nyuma could not complete that request." });
    expect(previous).not.toHaveProperty("listings");
  });

  it("refuses a real workspace when the token is missing or blank", async () => {
    const store = memoryStore();
    const api = trackingApi([ownedListing(FARMER_A)]);
    for (const token of [null, " ", ""]) {
      const loaded = await loadWorkspaceRecords({
        user: account(FARMER_A, "farmer"),
        token,
        api: api.client,
        sampleRepository: throwingRepository(store),
      });
      expect(loaded.ok).toBe(false);
      if (loaded.ok) continue;
      expect(loaded.code).toBe("unauthenticated");
    }
    expect(api.calls).toEqual([]);
    expect(store.reads).toEqual([]);
  });

  it("loads agreements, purchases, and outcomes for one account and not the next", async () => {
    const store = memoryStore();
    const firstApi = trackingApi([], [], [], [], [agreementRow("c-a")], [purchaseRow("p-a", "c-a")], [outcomeRow("o-a", "Collected")]);
    const first = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: firstApi.client,
      sampleRepository: throwingRepository(store),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.records.commitments.map((row) => row.id)).toEqual(["c-a"]);
    expect(first.records.purchases.map((row) => row.listingId)).toEqual(["listing-a"]);
    expect(first.records.outcomes.map((row) => row.notes)).toEqual(["Collected"]);
    expect(firstApi.calls.map((call) => call.name)).toContain("listAgreements");
    expect(firstApi.calls.map((call) => call.name).some((name) => name.startsWith("listMarket") && name !== "listMarketListings" && name !== "listMarketRequirements")).toBe(false);
    const cleared = reduceWorkspaceLoad({ phase: "ready", listings: first.records.listings }, { type: "reset" });
    expect(cleared).toEqual({ phase: "loading" });
    const second = await loadWorkspaceRecords({
      user: account(FARMER_B, "trader"),
      token: "token-b",
      api: trackingApi([], [], [], [], [agreementRow("c-b")]).client,
      sampleRepository: throwingRepository(store),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.records.commitments.map((row) => row.id)).toEqual(["c-b"]);
    expect(second.records.commitments.some((row) => row.id === "c-a")).toBe(false);
    expect(store.reads).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toBe(SAMPLE_DOCUMENT);
  });

  it("creates an agreement, updates only its status, and records a purchase without a listing id", async () => {
    const api = trackingApi();
    const user = account(FARMER_A, "farmer");
    const created = await saveAccountAgreement({
      user,
      token: "token-a",
      api: api.client,
      values: { listingId: "listing-a", buyerDemandId: "demand-a", quantity: "6", price: "40", expectedFulfilmentDate: "2026-11-06" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe("confirmed");
    const confirmed = await updateAccountAgreementStatus({
      user,
      token: "token-a",
      api: api.client,
      id: created.value.id,
      status: "cancelled",
    });
    expect(confirmed.ok).toBe(true);
    const bought = await saveAccountPurchase({
      user,
      token: "token-a",
      api: api.client,
      commitmentId: created.value.id,
      values: { quantity: "3", price: "41", purchaseDate: "2026-11-06" },
    });
    expect(bought.ok).toBe(true);
    expect(api.calls.map((call) => call.name)).toEqual(["createAgreement", "updateAgreement", "createPurchase"]);
    const agreementCall = api.calls[0];
    expect(agreementCall?.body).toMatchObject({ listingId: "listing-a", buyerDemandId: "demand-a", status: "confirmed", agreedQuantity: 6 });
    expect(JSON.stringify(agreementCall?.body)).not.toContain("ownerId");
    expect(JSON.stringify(agreementCall?.body)).not.toContain(FARMER_A);
    expect(api.calls[1]?.patch).toEqual({ status: "cancelled" });
    expect(JSON.stringify(api.calls[2]?.body)).not.toContain("listingId");
    expect(api.calls[2]?.body).toMatchObject({ commitmentId: created.value.id, actualQuantity: 3 });
  });

  it("records an outcome without an agreement id and keeps buyer notes unavailable", async () => {
    const api = trackingApi([], [], [], [], [], [], [outcomeRow("o-sold", null, "p-a")]);
    const user = account(FARMER_A, "farmer");
    const purchase = {
      id: "p-a",
      commitmentId: "c-a",
      listingId: "listing-a",
      actualQuantity: 3,
      quantityUnit: "kg" as const,
      actualPriceKshPerKg: 41,
      purchaseDate: "2026-11-06",
      recordedAt: "2026-11-05T00:00:00.000Z",
    };
    const saved = await saveAccountOutcome({
      user,
      token: "token-a",
      api: api.client,
      values: {
        listingId: "listing-a",
        category: "sold",
        saleKind: "purchase",
        purchaseId: "p-a",
        quantity: "3",
        recordedDate: "2026-11-06",
        notes: "Collected in Kitui",
      },
      purchase,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.notes).toBe("Collected in Kitui");
    expect(outcomeNoteText(null)).toBe("Notes are not available.");
    expect(JSON.stringify(api.calls[0]?.body)).not.toContain("commitmentId");
    expect(api.calls[0]?.body).toMatchObject({ listingId: "listing-a", purchaseId: "p-a", category: "sold", notes: "Collected in Kitui" });
    const loaded = await loadWorkspaceRecords({
      user: account(BUYER_A, "buyer"),
      token: "token-buyer",
      api: trackingApi([], [], [], [], [], [], [outcomeRow("o-buyer", null)]).client,
      sampleRepository: null,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.records.outcomes[0]?.notes).toBeNull();
    expect(outcomeNoteText("")).toBeNull();
  });

  it("shows authorization and conflict errors and does not read sample records", async () => {
    const store = memoryStore();
    const denied = trackingApi();
    denied.fail = new NyumaApiError(403, "role-not-granted");
    const role = await saveAccountAgreement({
      user: account(FARMER_A, "farmer"),
      token: "token-a",
      api: denied.client,
      values: { listingId: "listing-a", buyerDemandId: "demand-a", quantity: "6", price: "40", expectedFulfilmentDate: "2026-11-06" },
    });
    expect(role).toMatchObject({ ok: false, code: "role-not-granted" });
    const conflicted = trackingApi();
    conflicted.fail = new NyumaApiError(409, "conflict");
    const purchase = await saveAccountPurchase({
      user: account(BUYER_A, "buyer"),
      token: "token-buyer",
      api: conflicted.client,
      commitmentId: "c-a",
      values: { quantity: "9", price: "41", purchaseDate: "2026-11-06" },
    });
    expect(purchase.ok).toBe(false);
    if (purchase.ok) return;
    expect(purchase.code).toBe("conflict");
    expect(purchase.message).toContain("quantity");
    const missing = await loadWorkspaceRecords({
      user: account(FARMER_A, "farmer"),
      token: null,
      api: trackingApi().client,
      sampleRepository: throwingRepository(store),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing).not.toHaveProperty("records");
    expect(store.reads).toEqual([]);
    const sampleUser = sample("farmer@nyuma.ke");
    expect(participantLabel(sampleUser, sampleUser.id, "listing")).not.toBe("published");
    expect(participantLabel(account(FARMER_A, "farmer"), "published", "requirement")).toBe("Published requirement");
    expect(participantLabel(account(FARMER_A, "trader"), "published", "listing")).not.toContain(FARMER_A);
  });

  it("keeps a sample agreement in browser storage and refuses the account writer", async () => {
    const store = memoryStore(false);
    const repository = localRepository(store);
    const user = sample("farmer@nyuma.ke");
    const listing = await repository.createListing({ ...draftListing(user.id), status: "open", quantityKind: "available" });
    const demand = await repository.createBuyerDemand({
      buyerId: sample("buyer@nyuma.ke").id,
      commodity: "Watermelon",
      requestedQuantity: 8,
      quantityUnit: "kg",
      preferredLocation: "Nairobi",
      collectionWindow: "Today",
      indicativePriceKshPerKg: 42,
      status: "open",
    });
    expect(listing.ok && demand.ok).toBe(true);
    if (!listing.ok || !demand.ok) return;
    const saved = await repository.recordCommitment({
      listingId: listing.value.id,
      buyerDemandId: demand.value.id,
      agreedQuantity: 6,
      quantityUnit: "kg",
      agreedPriceKshPerKg: 40,
      expectedFulfilmentDate: "2026-11-06",
      status: "confirmed",
    });
    expect(saved.ok).toBe(true);
    const api = trackingApi();
    const loaded = await loadWorkspaceRecords({
      user,
      token: "should-not-be-sent",
      api: api.client,
      sampleRepository: repository,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe("sample");
    expect(loaded.records.commitments).toHaveLength(1);
    expect(api.calls).toEqual([]);
    const refused = await saveAccountAgreement({
      user,
      token: "should-not-be-sent",
      api: api.client,
      values: { listingId: listing.value.id, buyerDemandId: demand.value.id, quantity: "1", price: "40", expectedFulfilmentDate: "2026-11-06" },
    });
    expect(refused.ok).toBe(false);
    expect(api.calls).toEqual([]);
    expect(store.raw[COORDINATION_STORAGE_KEY]).toContain(listing.value.id);
    expect(store.raw[SCENARIO_STORAGE_KEY]).toBe(SCENARIO_DOCUMENT);
  });
});

function sample(email: string): SessionUser {
  const known = SAMPLE_USERS.find((item) => item.email === email);
  if (!known) throw new Error(email);
  const result = signIn(known.email, known.password);
  if (!result.ok) throw new Error(email);
  return result.user;
}

function account(id: string, role: "farmer" | "trader" | "buyer" | "administrator"): SessionUser {
  return {
    version: 1,
    id,
    name: "Account",
    email: "person@example.com",
    role,
    sample: false,
    grantedRoles: [role],
  };
}

function draftListing(ownerId: string) {
  return {
    ownerId,
    commodity: "Watermelon" as const,
    quantity: 10,
    quantityUnit: "kg" as const,
    quantityKind: "expected" as const,
    location: "Kitui" as const,
    availabilityWindow: "3 hours" as const,
    askingPriceKshPerKg: 40,
    status: "draft" as const,
  };
}

function ownedListing(ownerId: string, id = "listing-a"): ApiListing {
  return {
    id,
    ownerId,
    commodity: "Watermelon",
    quantity: 10.5,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40.25,
    status: "draft",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function ownedDomain(ownerId: string): Listing {
  return ownedListing(ownerId);
}

function marketOwnedListing(): ApiListing {
  return { ...ownedListing("published", "listing-market"), status: "open" };
}

function ownedRequirement(buyerId: string): ApiRequirement {
  return {
    id: "demand-a",
    buyerId,
    commodity: "Watermelon",
    requestedQuantity: 8,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function marketRequirement(): ApiRequirement {
  return { ...ownedRequirement("published"), id: "demand-market", status: "open" };
}

function agreementRow(id: string): ApiAgreement {
  return {
    id,
    listingId: "listing-a",
    buyerDemandId: "demand-a",
    agreedQuantity: 6,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-06",
    status: "confirmed",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function purchaseRow(id: string, commitmentId: string): ApiPurchase {
  return {
    id,
    commitmentId,
    listingId: "listing-a",
    actualQuantity: 3,
    quantityUnit: "kg",
    actualPriceKshPerKg: 41,
    purchaseDate: "2026-11-06",
    recordedAt: "2026-11-05T00:00:00.000Z",
  };
}

function outcomeRow(id: string, notes: string | null, purchaseId: string | null = null): ApiOutcome {
  return {
    id,
    listingId: "listing-a",
    commitmentId: purchaseId ? "c-a" : null,
    purchaseId,
    category: "sold",
    quantity: 3,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes,
    recordedAt: "2026-11-05T00:00:00.000Z",
  };
}

function trackingApi(
  listings: ApiListing[] = [],
  requirements: ApiRequirement[] = [],
  marketListings: ApiListing[] = [],
  marketRequirements: ApiRequirement[] = [],
  agreements: ApiAgreement[] = [],
  purchases: ApiPurchase[] = [],
  outcomes: ApiOutcome[] = [],
) {
  const calls: Array<{ name: string; body?: unknown; patch?: unknown }> = [];
  const state = { fail: null as NyumaApiError | null };
  const client: NyumaApi = {
    async bootstrap() {
      throw new Error("unused");
    },
    async account() {
      throw new Error("unused");
    },
    async selectWorkspace() {
      throw new Error("unused");
    },
    async submitRoleRequests() {
      throw new Error("unused");
    },
    async listRoleRequests() {
      throw new Error("unused");
    },
    async createListing(_token, input) {
      calls.push({ name: "createListing", body: input });
      if (state.fail) throw state.fail;
      return { ...listings[0]!, status: input.status, quantity: input.quantity };
    },
    async listListings() {
      calls.push({ name: "listListings" });
      if (state.fail) throw state.fail;
      return listings;
    },
    async getListing() {
      calls.push({ name: "getListing" });
      return listings[0]!;
    },
    async updateListing(_token, _id, patch) {
      calls.push({ name: "updateListing", patch });
      return { ...listings[0]!, ...patch };
    },
    async deleteListing() {
      calls.push({ name: "deleteListing" });
    },
    async listMarketListings() {
      calls.push({ name: "listMarketListings" });
      return marketListings.map((row) => ({
        id: row.id,
        commodity: row.commodity,
        quantity: row.quantity,
        quantityUnit: "kg" as const,
        quantityKind: row.quantityKind,
        location: row.location,
        availabilityWindow: row.availabilityWindow,
        askingPriceKshPerKg: row.askingPriceKshPerKg,
        status: "open" as const,
      }));
    },
    async createRequirement(_token, input) {
      calls.push({ name: "createRequirement", body: input });
      return { ...requirements[0]!, status: input.status, requestedQuantity: input.requestedQuantity };
    },
    async listRequirements() {
      calls.push({ name: "listRequirements" });
      return requirements;
    },
    async getRequirement() {
      return requirements[0]!;
    },
    async updateRequirement(_token, _id, patch) {
      calls.push({ name: "updateRequirement", patch });
      return { ...requirements[0]!, ...patch };
    },
    async deleteRequirement() {
      calls.push({ name: "deleteRequirement" });
    },
    async listMarketRequirements() {
      calls.push({ name: "listMarketRequirements" });
      if (state.fail) throw state.fail;
      return marketRequirements.map((row) => ({
        id: row.id,
        commodity: row.commodity,
        requestedQuantity: row.requestedQuantity,
        quantityUnit: "kg" as const,
        preferredLocation: row.preferredLocation,
        collectionWindow: row.collectionWindow,
        indicativePriceKshPerKg: row.indicativePriceKshPerKg,
        status: "open" as const,
      }));
    },
    async createAgreement(_token, input) {
      calls.push({ name: "createAgreement", body: input });
      if (state.fail) throw state.fail;
      return { ...agreementRow("c-new"), ...input, quantityUnit: "kg" as const };
    },
    async listAgreements() {
      calls.push({ name: "listAgreements" });
      if (state.fail) throw state.fail;
      return agreements;
    },
    async getAgreement() {
      calls.push({ name: "getAgreement" });
      return agreements[0] ?? agreementRow("c-new");
    },
    async updateAgreement(_token, id, patch) {
      calls.push({ name: "updateAgreement", patch });
      if (state.fail) throw state.fail;
      return { ...(agreements[0] ?? agreementRow(id)), status: patch.status };
    },
    async createPurchase(_token, input) {
      calls.push({ name: "createPurchase", body: input });
      if (state.fail) throw state.fail;
      return { ...purchaseRow("p-new", input.commitmentId), actualQuantity: input.actualQuantity, actualPriceKshPerKg: input.actualPriceKshPerKg, purchaseDate: input.purchaseDate };
    },
    async listPurchases() {
      calls.push({ name: "listPurchases" });
      if (state.fail) throw state.fail;
      return purchases;
    },
    async getPurchase() {
      calls.push({ name: "getPurchase" });
      return purchases[0] ?? purchaseRow("p-new", "c-new");
    },
    async createOutcome(_token, input) {
      calls.push({ name: "createOutcome", body: input });
      if (state.fail) throw state.fail;
      return { ...outcomeRow("o-new", input.notes, input.purchaseId), ...input, quantityUnit: "kg" as const };
    },
    async listOutcomes() {
      calls.push({ name: "listOutcomes" });
      if (state.fail) throw state.fail;
      return outcomes;
    },
    async getOutcome() {
      calls.push({ name: "getOutcome" });
      return outcomes[0] ?? outcomeRow("o-new", null);
    },
  };
  return {
    client,
    calls,
    get fail() {
      return state.fail;
    },
    set fail(error: NyumaApiError | null) {
      state.fail = error;
    },
  };
}

function localRepository(store: CoordinationKeyValueStore): CoordinationRepository {
  return createLocalCoordinationRepository(store, {
    clock: createSteppedClock("2026-11-05T00:00:00.000Z"),
    ids: createSequentialIdGenerator(),
  });
}

function memoryStore(seed = true): CoordinationKeyValueStore & { raw: Record<string, string>; reads: string[] } {
  const raw: Record<string, string> = {
    [SCENARIO_STORAGE_KEY]: SCENARIO_DOCUMENT,
  };
  if (seed) raw[COORDINATION_STORAGE_KEY] = SAMPLE_DOCUMENT;
  const reads: string[] = [];
  return {
    raw,
    reads,
    getItem(key) {
      reads.push(key);
      return key in raw ? raw[key] : null;
    },
    setItem(key, value) {
      raw[key] = value;
    },
  };
}

function throwingRepository(store: { reads: string[] }): CoordinationRepository {
  const fail = async () => {
    store.reads.push(COORDINATION_STORAGE_KEY);
    throw new Error("real account read the sample repository");
  };
  return {
    listListings: fail,
    getListing: fail,
    createListing: fail,
    updateListing: fail,
    listBuyerDemands: fail,
    getBuyerDemand: fail,
    createBuyerDemand: fail,
    updateBuyerDemand: fail,
    listCommitments: fail,
    getCommitment: fail,
    recordCommitment: fail,
    updateCommitment: fail,
    listPurchases: fail,
    getPurchase: fail,
    recordPurchase: fail,
    listOutcomes: fail,
    getOutcome: fail,
    recordOutcome: fail,
  };
}
