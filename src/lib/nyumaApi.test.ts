import { describe, expect, it } from "vitest";
import { createNyumaClient, NyumaApiError, readApiBaseUrl, type ApiFetch } from "./nyumaApi";

const token = "access-token-for-tests";
const otherAccount = "11111111-1111-4111-8111-111111111111";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function accountBody(roles: string[] = [], activeRole: string | null = null) {
  return {
    ok: true,
    account: {
      id: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3",
      status: "active",
      roles,
      activeRole,
    },
  };
}

describe("Nyuma API client", () => {
  it("rejects an API URL that carries credentials", () => {
    expect(readApiBaseUrl(undefined)).toEqual({ ok: true, url: "http://127.0.0.1:8787" });
    expect(readApiBaseUrl("http://user:secret@127.0.0.1:8787").ok).toBe(false);
    expect(readApiBaseUrl("notaurl").ok).toBe(false);
  });

  it("attaches the bearer token and does not send an account id", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: ApiFetch = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/me/role-requests") && init.method === "POST") {
        return response(200, {
          ok: true,
          requests: [{ id: "request-1", role: "farmer", status: "pending", requestedAt: "2026-11-05T00:00:00.000Z", decidedAt: null }],
        });
      }
      return response(200, accountBody());
    };
    const api = createNyumaClient("http://127.0.0.1:8787", fetchImpl);
    await api.bootstrap(token);
    await api.submitRoleRequests(token, ["farmer"]);
    expect(seen[0]?.init.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(seen[0]?.init.body).toBe("{}");
    expect(String(seen[1]?.init.body)).toBe(JSON.stringify({ roles: ["farmer"] }));
    expect(JSON.stringify(seen)).not.toContain(otherAccount);
    expect(JSON.stringify(seen)).not.toContain("userId");
  });

  it("does not call the API before a token exists or for an ungranted ordinary role name", async () => {
    let calls = 0;
    const fetchImpl: ApiFetch = async () => {
      calls += 1;
      return response(200, accountBody());
    };
    const api = createNyumaClient("http://127.0.0.1:8787", fetchImpl);
    await expect(api.account(" ")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(api.submitRoleRequests(token, ["administrator"])).rejects.toMatchObject({ code: "invalid-request" });
    await expect(api.selectWorkspace(token, "owner")).rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toBe(0);
  });

  it("maps 401, 403, 429, and server errors without echoing the token", async () => {
    const cases = [
      { status: 401, error: "unauthenticated" },
      { status: 403, error: "workspace-not-assigned" },
      { status: 403, error: "account-disabled" },
      { status: 429, error: "rate-limited" },
      { status: 500, error: "request-failed" },
      { status: 503, error: token },
    ];
    for (const item of cases) {
      const api = createNyumaClient("http://127.0.0.1:8787", async () => response(item.status, { ok: false, error: item.error }));
      const error = await api.account(token).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(NyumaApiError);
      if (!(error instanceof NyumaApiError)) continue;
      expect(error.status).toBe(item.status);
      expect(String(error.message)).not.toContain(token);
      expect(error.code).not.toContain(token);
    }
  });

  it("sends listing and requirement writes without an owner, and maps 404 and 409", async () => {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    const listing = privateListing();
    const requirement = privateRequirement();
    const fetchImpl: ApiFetch = async (url, init) => {
      seen.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
      if (init.method === "DELETE") return response(200, { ok: true });
      if (url.endsWith("/market/listings")) return response(200, { ok: true, listings: [marketListing()] });
      if (url.endsWith("/market/requirements")) return response(200, { ok: true, requirements: [marketRequirement()] });
      if (url.includes("/buyer-requirements")) {
        return response(init.method === "GET" && url.endsWith("/me/buyer-requirements") ? 200 : 201, {
          ok: true,
          requirement,
          requirements: [requirement],
        });
      }
      return response(init.method === "GET" && url.endsWith("/me/listings") ? 200 : 201, { ok: true, listing, listings: [listing] });
    };
    const api = createNyumaClient("http://127.0.0.1:8787", fetchImpl);
    await api.createListing(token, listingWrite());
    await api.updateListing(token, listing.id, { status: "open", quantity: 12 });
    await api.listMarketListings(token);
    await api.createRequirement(token, requirementWrite());
    await api.updateRequirement(token, requirement.id, { status: "withdrawn" });
    await api.listMarketRequirements(token);
    await api.deleteListing(token, listing.id);
    const bodies = seen.map((call) => call.body).join("\n");
    expect(bodies).not.toContain("ownerId");
    expect(bodies).not.toContain("buyerId");
    expect(bodies).not.toContain("userId");
    expect(bodies).not.toContain(otherAccount);
    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8787/me/listings",
      `PATCH http://127.0.0.1:8787/me/listings/${listing.id}`,
      "GET http://127.0.0.1:8787/market/listings",
      "POST http://127.0.0.1:8787/me/buyer-requirements",
      `PATCH http://127.0.0.1:8787/me/buyer-requirements/${requirement.id}`,
      "GET http://127.0.0.1:8787/market/requirements",
      `DELETE http://127.0.0.1:8787/me/listings/${listing.id}`,
    ]);
    expect(seen[0]?.body).not.toContain("id");
    const missing = createNyumaClient("http://127.0.0.1:8787", async () => response(404, { ok: false, error: "not-found" }));
    await expect(missing.getListing(token, listing.id)).rejects.toMatchObject({ status: 404, code: "not-found" });
    const blocked = createNyumaClient("http://127.0.0.1:8787", async () => response(409, { ok: false, error: "relationship" }));
    await expect(blocked.deleteRequirement(token, requirement.id)).rejects.toMatchObject({ status: 409, code: "relationship" });
    const offline = createNyumaClient("http://127.0.0.1:8787", async () => {
      throw new Error("offline");
    });
    await expect(offline.listListings(token)).rejects.toMatchObject({ status: 0, code: "request-failed" });
  });

  it("sends agreement, purchase, and outcome calls with a bearer token and no party id", async () => {
    const seen: Array<{ url: string; method: string; body: string; authorization: string }> = [];
    const fetchImpl: ApiFetch = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, method: init.method ?? "GET", body: String(init.body ?? ""), authorization: headers.authorization });
      if (url.endsWith("/me/agreements") && init.method === "GET") return response(200, { ok: true, agreements: [agreementRow()] });
      if (url.endsWith("/me/agreements") && init.method === "POST") return response(201, { ok: true, agreement: agreementRow() });
      if (url.includes("/me/agreements/") && init.method === "PATCH") {
        return response(200, { ok: true, agreement: { ...agreementRow(), status: "cancelled" } });
      }
      if (url.includes("/me/agreements/")) return response(200, { ok: true, agreement: agreementRow() });
      if (url.endsWith("/me/purchases") && init.method === "POST") return response(201, { ok: true, purchase: purchaseRow() });
      if (url.endsWith("/me/purchases")) return response(200, { ok: true, purchases: [purchaseRow()] });
      if (url.includes("/me/purchases/")) return response(200, { ok: true, purchase: purchaseRow() });
      if (url.endsWith("/me/outcomes") && init.method === "POST") return response(201, { ok: true, outcome: outcomeRow("Collected") });
      if (url.endsWith("/me/outcomes")) return response(200, { ok: true, outcomes: [outcomeRow(null)] });
      if (url.includes("/me/outcomes/")) return response(200, { ok: true, outcome: outcomeRow(null) });
      return response(404, { ok: false, error: "not-found" });
    };
    const api = createNyumaClient("http://127.0.0.1:8787", fetchImpl);
    await api.createAgreement(token, {
      listingId: "listing001",
      buyerDemandId: "demand001",
      agreedQuantity: 6,
      agreedPriceKshPerKg: 40,
      expectedFulfilmentDate: "2026-11-06",
      status: "confirmed",
    });
    await api.listAgreements(token);
    await api.getAgreement(token, "agreement1");
    await api.updateAgreement(token, "agreement1", { status: "cancelled" });
    await api.createPurchase(token, {
      commitmentId: "agreement1",
      actualQuantity: 3,
      actualPriceKshPerKg: 41,
      purchaseDate: "2026-11-06",
    });
    await api.listPurchases(token);
    await api.getPurchase(token, "purchase01");
    await api.createOutcome(token, {
      listingId: "listing001",
      category: "sold",
      quantity: 3,
      recordedDate: "2026-11-06",
      notes: "Collected",
      purchaseId: "purchase01",
    });
    const hidden = await api.listOutcomes(token);
    await api.getOutcome(token, "outcome001");
    expect(hidden[0]?.notes).toBeNull();
    const joined = JSON.stringify(seen);
    expect(joined).not.toContain(otherAccount);
    expect(joined).not.toContain("ownerId");
    expect(joined).not.toContain("buyerId");
    expect(joined).not.toContain("commitmentId\":\"c");
    expect(joined).not.toContain("/market/agreements");
    expect(joined).not.toContain("/market/purchases");
    expect(joined).not.toContain("/market/outcomes");
    expect(seen.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8787/me/agreements",
      "GET http://127.0.0.1:8787/me/agreements",
      "GET http://127.0.0.1:8787/me/agreements/agreement1",
      "PATCH http://127.0.0.1:8787/me/agreements/agreement1",
      "POST http://127.0.0.1:8787/me/purchases",
      "GET http://127.0.0.1:8787/me/purchases",
      "GET http://127.0.0.1:8787/me/purchases/purchase01",
      "POST http://127.0.0.1:8787/me/outcomes",
      "GET http://127.0.0.1:8787/me/outcomes",
      "GET http://127.0.0.1:8787/me/outcomes/outcome001",
    ]);
    expect(seen[3]?.body).toBe(JSON.stringify({ status: "cancelled" }));
    expect(seen[4]?.body).not.toContain("listingId");
    expect(seen[7]?.body).not.toContain("commitmentId");
    const expired = createNyumaClient("http://127.0.0.1:8787", async () => response(401, { ok: false, error: "unauthenticated" }));
    await expect(expired.listAgreements(token)).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    await expect(expired.createPurchase(" ", {
      commitmentId: "agreement1",
      actualQuantity: 1,
      actualPriceKshPerKg: 40,
      purchaseDate: "2026-11-06",
    })).rejects.toMatchObject({ code: "unauthenticated" });
    const conflict = createNyumaClient("http://127.0.0.1:8787", async () => response(409, { ok: false, error: "conflict" }));
    await expect(conflict.updateAgreement(token, "agreement1", { status: "fulfilled" })).rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

function listingWrite() {
  return {
    commodity: "Watermelon" as const,
    quantity: 10.5,
    quantityKind: "available" as const,
    location: "Kitui" as const,
    availabilityWindow: "3 hours" as const,
    askingPriceKshPerKg: 40.25,
    status: "draft" as const,
  };
}

function requirementWrite() {
  return {
    commodity: "Watermelon" as const,
    requestedQuantity: 8,
    preferredLocation: "Nairobi" as const,
    collectionWindow: "Today" as const,
    indicativePriceKshPerKg: 42,
    status: "open" as const,
  };
}

function privateListing() {
  return {
    id: "listing001",
    ownerId: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3",
    ...listingWrite(),
    quantityUnit: "kg" as const,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function privateRequirement() {
  return {
    id: "demand001",
    buyerId: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3",
    commodity: "Watermelon" as const,
    requestedQuantity: 8,
    quantityUnit: "kg" as const,
    preferredLocation: "Nairobi" as const,
    collectionWindow: "Today" as const,
    indicativePriceKshPerKg: 42,
    status: "open" as const,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function marketListing() {
  return {
    id: "listing001",
    commodity: "Watermelon" as const,
    quantity: 10.5,
    quantityUnit: "kg" as const,
    quantityKind: "available" as const,
    location: "Kitui" as const,
    availabilityWindow: "3 hours" as const,
    askingPriceKshPerKg: 40.25,
    status: "open" as const,
  };
}

function agreementRow() {
  return {
    id: "agreement1",
    listingId: "listing001",
    buyerDemandId: "demand001",
    agreedQuantity: 6,
    quantityUnit: "kg" as const,
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-06",
    status: "confirmed" as const,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function purchaseRow() {
  return {
    id: "purchase01",
    commitmentId: "agreement1",
    listingId: "listing001",
    actualQuantity: 3,
    quantityUnit: "kg" as const,
    actualPriceKshPerKg: 41,
    purchaseDate: "2026-11-06",
    recordedAt: "2026-11-05T00:00:00.000Z",
  };
}

function outcomeRow(notes: string | null) {
  return {
    id: "outcome001",
    listingId: "listing001",
    commitmentId: "agreement1",
    purchaseId: "purchase01",
    category: "sold" as const,
    quantity: 3,
    quantityUnit: "kg" as const,
    recordedDate: "2026-11-06",
    notes,
    recordedAt: "2026-11-05T00:00:00.000Z",
  };
}

function marketRequirement() {
  return {
    id: "demand001",
    commodity: "Watermelon" as const,
    requestedQuantity: 8,
    quantityUnit: "kg" as const,
    preferredLocation: "Nairobi" as const,
    collectionWindow: "Today" as const,
    indicativePriceKshPerKg: 42,
    status: "open" as const,
  };
}
