import type { BuyerDemand, Commitment, Listing, ListingStatus, Outcome, Purchase } from "../domain/records";
import type { CoordinationRepository } from "../domain/coordinationRepository";
import {
  commitmentDraftFromForm,
  demandDraftFromForm,
  listingDraftFromForm,
  outcomeDraftFromForm,
  purchaseDraftFromForm,
  type CommitmentFormValues,
  type DemandFormValues,
  type ListingFormValues,
  type OutcomeFormValues,
  type PurchaseFormValues,
} from "./coordinationForms";
import { accountMessage } from "./accountFlow";
import type { SessionUser } from "./auth";
import {
  NyumaApiError,
  type ApiAgreement,
  type ApiListing,
  type ApiOutcome,
  type ApiPurchase,
  type ApiRequirement,
  type MarketListing,
  type MarketRequirement,
  type NyumaApi,
} from "./nyumaApi";
import { demandMoveAllowed, listingMoveAllowed, listingLockedMessage, demandLockedMessage } from "./coordinationWorkflow";
import { SAMPLE_USERS } from "./sampleUsers";

/** Marker for a published market row. The API does not send the owner's account id. */
export const PUBLISHED_PARTY = "published";

const PUBLISHED_TIME = "1970-01-01T00:00:00.000Z";

export interface WorkspaceRecords {
  listings: readonly Listing[];
  demands: readonly BuyerDemand[];
  commitments: readonly Commitment[];
  purchases: readonly Purchase[];
  outcomes: readonly Outcome[];
}

export type WorkspaceLoad =
  | { ok: true; source: "sample" | "account"; records: WorkspaceRecords }
  | { ok: false; source: "sample" | "account"; code: string; message: string };

export type RecordSave<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function reduceWorkspaceLoad(
  current: { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; listings: readonly Listing[] },
  event: { type: "reset" } | { type: "error"; message: string } | { type: "ready"; listings: readonly Listing[] },
): { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; listings: readonly Listing[] } {
  if (event.type === "reset" || current.phase === "loading") {
    if (event.type === "error") return { phase: "error", message: event.message };
    if (event.type === "ready") return { phase: "ready", listings: event.listings };
    return { phase: "loading" };
  }
  if (event.type === "error") return { phase: "error", message: event.message };
  if (event.type === "ready") return { phase: "ready", listings: event.listings };
  return { phase: "loading" };
}

export async function loadWorkspaceRecords(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  sampleRepository: CoordinationRepository | null;
}): Promise<WorkspaceLoad> {
  if (input.user.sample) return loadSampleRecords(input.sampleRepository);
  return loadAccountRecords(input.token, input.api);
}

export async function loadOwnedListings(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  sampleRepository: CoordinationRepository | null;
}): Promise<{ ok: true; listings: Listing[] } | { ok: false; code: string; message: string }> {
  if (input.user.sample) {
    if (!input.sampleRepository) return { ok: false, code: "storage", message: "This browser blocked local storage, so listings could not be read." };
    const result = await input.sampleRepository.listListings();
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, listings: result.value.filter((listing) => listing.ownerId === input.user.id) };
  }
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  try {
    return { ok: true, listings: (await ready.api.listListings(ready.token)).map(ownedListing) };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function loadOwnedListing(input: {
  user: SessionUser;
  id: string;
  token: string | null;
  api: NyumaApi | null;
  sampleRepository: CoordinationRepository | null;
}): Promise<{ ok: true; listing: Listing } | { ok: false; code: string; message: string }> {
  if (input.user.sample) {
    if (!input.sampleRepository) return { ok: false, code: "storage", message: "This browser blocked local storage, so this listing could not be read." };
    const result = await input.sampleRepository.getListing(input.id);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, listing: result.value };
  }
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  try {
    const listing = ownedListing(await ready.api.getListing(ready.token, input.id));
    if (listing.ownerId !== input.user.id) return { ok: false, code: "not-found", message: accountMessage("not-found") };
    return { ok: true, listing };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function saveAccountListing(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  existing: Listing | null;
  values: ListingFormValues;
  status: ListingStatus;
}): Promise<RecordSave<Listing>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  if (input.existing && !listingMoveAllowed(input.existing.status, input.status)) {
    return { ok: false, code: "conflict", message: listingLockedMessage(input.existing.status) };
  }
  const draft = listingDraftFromForm(input.user.id, input.values, input.status);
  if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
  try {
    const saved = input.existing
      ? await ready.api.updateListing(ready.token, input.existing.id, {
          quantity: draft.value.quantity,
          quantityKind: draft.value.quantityKind,
          location: draft.value.location,
          availabilityWindow: draft.value.availabilityWindow,
          askingPriceKshPerKg: draft.value.askingPriceKshPerKg,
          status: input.status,
        })
      : await ready.api.createListing(ready.token, {
          commodity: draft.value.commodity,
          quantity: draft.value.quantity,
          quantityKind: draft.value.quantityKind,
          location: draft.value.location,
          availabilityWindow: draft.value.availabilityWindow,
          askingPriceKshPerKg: draft.value.askingPriceKshPerKg,
          status: input.status,
        });
    const listing = ownedListing(saved);
    if (listing.ownerId !== input.user.id) return { ok: false, code: "not-found", message: accountMessage("not-found") };
    return { ok: true, value: listing };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function loadOwnedRequirements(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  sampleRepository: CoordinationRepository | null;
}): Promise<{ ok: true; requirements: BuyerDemand[] } | { ok: false; code: string; message: string }> {
  if (input.user.sample) {
    if (!input.sampleRepository) return { ok: false, code: "storage", message: "This browser blocked local storage, so requirements could not be read." };
    const result = await input.sampleRepository.listBuyerDemands();
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, requirements: result.value.filter((demand) => demand.buyerId === input.user.id) };
  }
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  try {
    return { ok: true, requirements: (await ready.api.listRequirements(ready.token)).map(ownedRequirement) };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function loadOwnedRequirement(input: {
  user: SessionUser;
  id: string;
  token: string | null;
  api: NyumaApi | null;
  sampleRepository: CoordinationRepository | null;
}): Promise<{ ok: true; requirement: BuyerDemand } | { ok: false; code: string; message: string }> {
  if (input.user.sample) {
    if (!input.sampleRepository) return { ok: false, code: "storage", message: "This browser blocked local storage, so this requirement could not be read." };
    const result = await input.sampleRepository.getBuyerDemand(input.id);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, requirement: result.value };
  }
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  try {
    const requirement = ownedRequirement(await ready.api.getRequirement(ready.token, input.id));
    if (requirement.buyerId !== input.user.id) return { ok: false, code: "not-found", message: accountMessage("not-found") };
    return { ok: true, requirement };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function saveAccountRequirement(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  existing: BuyerDemand | null;
  values: DemandFormValues;
  status: BuyerDemand["status"];
}): Promise<RecordSave<BuyerDemand>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  if (input.existing && !demandMoveAllowed(input.existing.status, input.status)) {
    return { ok: false, code: "conflict", message: demandLockedMessage(input.existing.status) };
  }
  const draft = demandDraftFromForm(input.user.id, input.values, input.status);
  if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
  try {
    const saved = input.existing
      ? await ready.api.updateRequirement(ready.token, input.existing.id, {
          requestedQuantity: draft.value.requestedQuantity,
          preferredLocation: draft.value.preferredLocation,
          collectionWindow: draft.value.collectionWindow,
          indicativePriceKshPerKg: draft.value.indicativePriceKshPerKg,
          status: input.status,
        })
      : await ready.api.createRequirement(ready.token, {
          commodity: draft.value.commodity,
          requestedQuantity: draft.value.requestedQuantity,
          preferredLocation: draft.value.preferredLocation,
          collectionWindow: draft.value.collectionWindow,
          indicativePriceKshPerKg: draft.value.indicativePriceKshPerKg,
          status: "open",
        });
    const requirement = ownedRequirement(saved);
    if (requirement.buyerId !== input.user.id) return { ok: false, code: "not-found", message: accountMessage("not-found") };
    return { ok: true, value: requirement };
  } catch (error) {
    return apiFailure(error);
  }
}

export async function saveAccountAgreement(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  values: CommitmentFormValues;
}): Promise<RecordSave<Commitment>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  const draft = commitmentDraftFromForm(input.values);
  if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
  if (draft.value.status !== "proposed" && draft.value.status !== "confirmed") {
    return refused("invalid-request");
  }
  try {
    const saved = await ready.api.createAgreement(ready.token, {
      listingId: draft.value.listingId,
      buyerDemandId: draft.value.buyerDemandId,
      agreedQuantity: draft.value.agreedQuantity,
      agreedPriceKshPerKg: draft.value.agreedPriceKshPerKg,
      expectedFulfilmentDate: draft.value.expectedFulfilmentDate,
      status: draft.value.status,
    });
    return { ok: true, value: agreementRecord(saved) };
  } catch (error) {
    return activityFailure(error, "That agreement was not saved. The listing and requirement must be open, the same produce, and a compatible collection window, and the quantity must fit.");
  }
}

export async function updateAccountAgreementStatus(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  id: string;
  status: "confirmed" | "cancelled" | "fulfilled";
}): Promise<RecordSave<Commitment>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  try {
    const saved = await ready.api.updateAgreement(ready.token, input.id, { status: input.status });
    return { ok: true, value: agreementRecord(saved) };
  } catch (error) {
    return activityFailure(error, "That status change was not saved.");
  }
}

export async function saveAccountPurchase(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  commitmentId: string;
  values: PurchaseFormValues;
}): Promise<RecordSave<Purchase>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  const draft = purchaseDraftFromForm(input.commitmentId, "listing-from-agreement", input.values);
  if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
  try {
    const saved = await ready.api.createPurchase(ready.token, {
      commitmentId: input.commitmentId,
      actualQuantity: draft.value.actualQuantity,
      actualPriceKshPerKg: draft.value.actualPriceKshPerKg,
      purchaseDate: draft.value.purchaseDate,
    });
    return { ok: true, value: purchaseRecord(saved) };
  } catch (error) {
    return activityFailure(error, "That purchase was not saved. Check the quantity still left and that the agreement is confirmed.");
  }
}

export async function saveAccountOutcome(input: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  values: OutcomeFormValues;
  purchase: Purchase | null;
}): Promise<RecordSave<Outcome>> {
  if (input.user.sample) return refused("invalid-request");
  const ready = accountReady(input.token, input.api);
  if (!ready.ok) return ready;
  const linked = outcomeLink(input.values, input.purchase);
  if (!linked.ok) return linked;
  const draft = outcomeDraftFromForm(input.values, linked.purchaseId, null);
  if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
  try {
    const saved = await ready.api.createOutcome(ready.token, {
      listingId: draft.value.listingId,
      category: draft.value.category,
      quantity: draft.value.quantity,
      recordedDate: draft.value.recordedDate,
      notes: draft.value.notes,
      purchaseId: linked.purchaseId,
    });
    return { ok: true, value: outcomeRecord(saved) };
  } catch (error) {
    return activityFailure(error, "That outcome was not saved.");
  }
}

/** A buyer response uses null. An empty string is a note the owner left blank. */
export function outcomeNoteText(notes: string | null): string | null {
  if (notes === null) return "Notes are not available.";
  if (notes === "") return null;
  return notes;
}

/** Sample names stay on the sample path. A published market row is not an account. */
export function participantLabel(user: SessionUser, id: string | undefined, kind: "listing" | "requirement"): string {
  if (user.sample) {
    if (!id) return "Unknown account";
    return SAMPLE_USERS.find((account) => account.id === id)?.name ?? "Sample account";
  }
  if (id && id === user.id) return "Your account";
  if (!id || id === PUBLISHED_PARTY) return kind === "listing" ? "Published listing" : "Published requirement";
  return kind === "listing" ? "Listing" : "Requirement";
}

async function loadSampleRecords(repository: CoordinationRepository | null): Promise<WorkspaceLoad> {
  if (!repository) {
    return { ok: false, source: "sample", code: "storage", message: "This browser blocked local storage, so saved produce could not be read." };
  }
  const [listings, demands, commitments, purchases, outcomes] = await Promise.all([
    repository.listListings(),
    repository.listBuyerDemands(),
    repository.listCommitments(),
    repository.listPurchases(),
    repository.listOutcomes(),
  ]);
  if (!listings.ok) return { ok: false, source: "sample", code: listings.code, message: listings.message };
  if (!demands.ok) return { ok: false, source: "sample", code: demands.code, message: demands.message };
  if (!commitments.ok) return { ok: false, source: "sample", code: commitments.code, message: commitments.message };
  if (!purchases.ok) return { ok: false, source: "sample", code: purchases.code, message: purchases.message };
  if (!outcomes.ok) return { ok: false, source: "sample", code: outcomes.code, message: outcomes.message };
  return {
    ok: true,
    source: "sample",
    records: {
      listings: listings.value,
      demands: demands.value,
      commitments: commitments.value,
      purchases: purchases.value,
      outcomes: outcomes.value,
    },
  };
}

async function loadAccountRecords(token: string | null, api: NyumaApi | null): Promise<WorkspaceLoad> {
  const ready = accountReady(token, api);
  if (!ready.ok) return { ok: false, source: "account", code: ready.code, message: ready.message };
  try {
    const [ownedListings, marketListings, ownedRequirements, marketRequirements, agreements, purchases, outcomes] = await Promise.all([
      ready.api.listListings(ready.token),
      ready.api.listMarketListings(ready.token),
      ready.api.listRequirements(ready.token),
      ready.api.listMarketRequirements(ready.token),
      ready.api.listAgreements(ready.token),
      ready.api.listPurchases(ready.token),
      ready.api.listOutcomes(ready.token),
    ]);
    return {
      ok: true,
      source: "account",
      records: {
        listings: mergeById(ownedListings.map(ownedListing), marketListings.map(publishedListing)),
        demands: mergeById(ownedRequirements.map(ownedRequirement), marketRequirements.map(publishedRequirement)),
        commitments: agreements.map(agreementRecord),
        purchases: purchases.map(purchaseRecord),
        outcomes: outcomes.map(outcomeRecord),
      },
    };
  } catch (error) {
    const failure = apiFailure(error);
    return { ok: false, source: "account", code: failure.code, message: failure.message };
  }
}

function ownedListing(row: ApiListing): Listing {
  return { ...row, quantityUnit: "kg" };
}

function publishedListing(row: MarketListing): Listing {
  return {
    ...row,
    ownerId: PUBLISHED_PARTY,
    quantityUnit: "kg",
    createdAt: PUBLISHED_TIME,
    updatedAt: PUBLISHED_TIME,
  };
}

function ownedRequirement(row: ApiRequirement): BuyerDemand {
  return { ...row, quantityUnit: "kg" };
}

function publishedRequirement(row: MarketRequirement): BuyerDemand {
  return {
    ...row,
    buyerId: PUBLISHED_PARTY,
    quantityUnit: "kg",
    createdAt: PUBLISHED_TIME,
    updatedAt: PUBLISHED_TIME,
  };
}

function mergeById<T extends { id: string }>(owned: readonly T[], published: readonly T[]): T[] {
  const seen = new Set(owned.map((row) => row.id));
  return [...owned, ...published.filter((row) => !seen.has(row.id))];
}

function accountReady(
  token: string | null,
  api: NyumaApi | null,
): { ok: true; token: string; api: NyumaApi } | { ok: false; code: string; message: string } {
  if (!token || token.trim() === "") return refused("unauthenticated");
  if (!api) return refused("request-failed");
  return { ok: true, token, api };
}

function refused(code: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message: accountMessage(code) };
}

function apiFailure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof NyumaApiError) return { ok: false, code: error.code, message: accountMessage(error.code) };
  return refused("request-failed");
}

function activityFailure(error: unknown, conflict: string): { ok: false; code: string; message: string } {
  if (error instanceof NyumaApiError && error.code === "conflict") return { ok: false, code: error.code, message: conflict };
  return apiFailure(error);
}

function agreementRecord(row: ApiAgreement): Commitment {
  return { ...row, quantityUnit: "kg" };
}

function purchaseRecord(row: ApiPurchase): Purchase {
  return { ...row, quantityUnit: "kg" };
}

function outcomeRecord(row: ApiOutcome): Outcome {
  return { ...row, quantityUnit: "kg", notes: row.notes };
}

const OUTCOME_CATEGORIES = ["sold", "recovered", "spoiled", "donated", "disposed"] as const;

function outcomeLink(
  values: OutcomeFormValues,
  purchase: Purchase | null,
): { ok: true; purchaseId: string | null } | { ok: false; code: string; message: string } {
  if (!OUTCOME_CATEGORIES.some((category) => category === values.category)) {
    return { ok: false, code: "invalid", message: "Choose what happened to this produce." };
  }
  if (values.category !== "sold") {
    if (values.purchaseId.trim() !== "" || purchase) {
      return { ok: false, code: "invalid-request", message: "A purchase can only be linked to a sold outcome." };
    }
    return { ok: true, purchaseId: null };
  }
  if (values.saleKind === "external") return { ok: true, purchaseId: null };
  if (values.saleKind !== "purchase") {
    return { ok: false, code: "invalid", message: "Choose whether this sale is a saved purchase or a sale outside Nyuma." };
  }
  if (!purchase || purchase.id !== values.purchaseId || purchase.listingId !== values.listingId) {
    return { ok: false, code: "invalid", message: "Choose a purchase recorded against this listing." };
  }
  return { ok: true, purchaseId: purchase.id };
}
