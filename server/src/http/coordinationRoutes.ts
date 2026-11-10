import type { AccountView } from "../auth/identity.js";
import { RecordNotFound } from "../coordination/errors.js";
import {
  parseAgreementStatus,
  parseAgreementWrite,
  parseDemandPatch,
  parseDemandWrite,
  parseListingPatch,
  parseListingWrite,
  parseOutcomeWrite,
  parsePurchaseWrite,
  recordId,
} from "../coordination/input.js";
import type { CoordinationStore } from "../coordination/store.js";

export function isCoordinationRoute(path: string): boolean {
  return (
    path === "/me/listings" ||
    path === "/me/buyer-requirements" ||
    path === "/market/listings" ||
    path === "/market/requirements" ||
    path === "/me/agreements" ||
    path === "/me/purchases" ||
    path === "/me/outcomes" ||
    /^\/me\/listings\/[^/]+$/.test(path) ||
    /^\/me\/buyer-requirements\/[^/]+$/.test(path) ||
    /^\/me\/agreements\/[^/]+$/.test(path) ||
    /^\/me\/purchases\/[^/]+$/.test(path) ||
    /^\/me\/outcomes\/[^/]+$/.test(path)
  );
}

export async function coordinationResponse(
  method: string,
  path: string,
  account: AccountView,
  store: CoordinationStore,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const accountId = account.id;
  if (path === "/market/listings" && method === "GET") {
    return { status: 200, body: { ok: true, listings: await store.listOpenListings() } };
  }
  if (path === "/market/requirements" && method === "GET") {
    return { status: 200, body: { ok: true, requirements: await store.listOpenDemands() } };
  }
  if (path === "/me/listings" && method === "GET") {
    return { status: 200, body: { ok: true, listings: await store.listOwnListings(accountId) } };
  }
  if (path === "/me/listings" && method === "POST") {
    const listing = await store.createListing(accountId, parseListingWrite(body));
    return { status: 201, body: { ok: true, listing } };
  }
  if (path === "/me/buyer-requirements" && method === "GET") {
    return { status: 200, body: { ok: true, requirements: await store.listOwnDemands(accountId) } };
  }
  if (path === "/me/buyer-requirements" && method === "POST") {
    const requirement = await store.createDemand(accountId, parseDemandWrite(body));
    return { status: 201, body: { ok: true, requirement } };
  }
  if (path === "/me/agreements" && method === "GET") {
    return { status: 200, body: { ok: true, agreements: await store.listAgreements(accountId) } };
  }
  if (path === "/me/agreements" && method === "POST") {
    const agreement = await store.createAgreement(accountId, parseAgreementWrite(body));
    return { status: 201, body: { ok: true, agreement } };
  }
  if (path === "/me/purchases" && method === "GET") {
    return { status: 200, body: { ok: true, purchases: await store.listPurchases(accountId) } };
  }
  if (path === "/me/purchases" && method === "POST") {
    const purchase = await store.createPurchase(accountId, parsePurchaseWrite(body));
    return { status: 201, body: { ok: true, purchase } };
  }
  if (path === "/me/outcomes" && method === "GET") {
    return { status: 200, body: { ok: true, outcomes: await store.listOutcomes(accountId) } };
  }
  if (path === "/me/outcomes" && method === "POST") {
    const outcome = await store.createOutcome(accountId, parseOutcomeWrite(body));
    return { status: 201, body: { ok: true, outcome } };
  }

  const listingId = path.match(/^\/me\/listings\/([^/]+)$/)?.[1];
  if (listingId) {
    const id = ownedId(listingId);
    if (method === "GET") return { status: 200, body: { ok: true, listing: await store.getOwnListing(accountId, id) } };
    if (method === "PATCH") {
      const listing = await store.updateListing(accountId, id, parseListingPatch(body));
      return { status: 200, body: { ok: true, listing } };
    }
    if (method === "DELETE") {
      await store.deleteListing(accountId, id);
      return { status: 200, body: { ok: true } };
    }
  }

  const agreementId = path.match(/^\/me\/agreements\/([^/]+)$/)?.[1];
  if (agreementId) {
    const id = ownedId(agreementId);
    if (method === "GET") return { status: 200, body: { ok: true, agreement: await store.getAgreement(accountId, id) } };
    if (method === "PATCH") {
      const agreement = await store.updateAgreementStatus(accountId, id, parseAgreementStatus(body));
      return { status: 200, body: { ok: true, agreement } };
    }
  }

  const purchaseId = path.match(/^\/me\/purchases\/([^/]+)$/)?.[1];
  if (purchaseId && method === "GET") {
    return { status: 200, body: { ok: true, purchase: await store.getPurchase(accountId, ownedId(purchaseId)) } };
  }

  const outcomeId = path.match(/^\/me\/outcomes\/([^/]+)$/)?.[1];
  if (outcomeId && method === "GET") {
    return { status: 200, body: { ok: true, outcome: await store.getOutcome(accountId, ownedId(outcomeId)) } };
  }

  const demandId = path.match(/^\/me\/buyer-requirements\/([^/]+)$/)?.[1];
  if (demandId) {
    const id = ownedId(demandId);
    if (method === "GET") return { status: 200, body: { ok: true, requirement: await store.getOwnDemand(accountId, id) } };
    if (method === "PATCH") {
      const requirement = await store.updateDemand(accountId, id, parseDemandPatch(body));
      return { status: 200, body: { ok: true, requirement } };
    }
    if (method === "DELETE") {
      await store.deleteDemand(accountId, id);
      return { status: 200, body: { ok: true } };
    }
  }

  throw new RecordNotFound();
}

function ownedId(value: string): string {
  try {
    return recordId(decodeURIComponent(value));
  } catch {
    throw new RecordNotFound();
  }
}
