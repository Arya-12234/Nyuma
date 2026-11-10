import type { CoordinationRepository } from "../domain/coordinationRepository";
import type {
  BuyerDemand,
  BuyerDemandStatus,
  Commitment,
  Listing,
  ListingPatch,
  ListingStatus,
  Outcome,
  OutcomeCategory,
  Purchase,
} from "../domain/records";
import { failure, success, type DomainResult } from "../domain/result";
import { agreementBlock, remainingCommitmentKg, remainingDemandKg, remainingListingKg } from "./coordinationActivity";
import { authorizeAction, authorizeOwnRecord } from "./access";
import { outcomeBlock } from "./outcomeAccounting";
import {
  commitmentDraftFromForm,
  demandDraftFromForm,
  listingDraftFromForm,
  outcomeDraftFromForm,
  purchaseDraftFromForm,
  refused,
  type CommitmentFormValues,
  type DemandFormValues,
  type ListingFormValues,
  type OutcomeFormValues,
  type PurchaseFormValues,
} from "./coordinationForms";
import type { SessionUser } from "./auth";

const LISTING_MOVES: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ["draft", "open", "withdrawn"],
  open: ["open", "closed", "withdrawn"],
  closed: [],
  withdrawn: [],
};

const DEMAND_MOVES: Record<BuyerDemandStatus, readonly BuyerDemandStatus[]> = {
  open: ["open", "closed", "withdrawn"],
  closed: [],
  withdrawn: [],
};

export async function createListingRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  values: ListingFormValues,
  status: "draft" | "open",
): Promise<DomainResult<Listing>> {
  const gate = authorizeAction(user, "create-listing");
  if (!gate.ok) return refused(gate.message);
  const draft = listingDraftFromForm(gate.user.id, values, status);
  if (!draft.ok) return draft;
  return repository.createListing(draft.value);
}

export async function updateListingRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  id: string,
  values: ListingFormValues,
  status: ListingStatus,
): Promise<DomainResult<Listing>> {
  const current = await repository.getListing(id);
  if (!current.ok) return current;
  const gate = authorizeOwnRecord(user, "edit-listing", current.value.ownerId);
  if (!gate.ok) return refused(gate.message);
  if (!listingMoveAllowed(current.value.status, status)) {
    return failure("conflict", listingLockedMessage(current.value.status));
  }
  const draft = listingDraftFromForm(current.value.ownerId, values, status);
  if (!draft.ok) return draft;
  const patch: ListingPatch = {
    quantity: draft.value.quantity,
    quantityKind: draft.value.quantityKind,
    location: draft.value.location,
    availabilityWindow: draft.value.availabilityWindow,
    askingPriceKshPerKg: draft.value.askingPriceKshPerKg,
    status,
  };
  return repository.updateListing(id, patch);
}

export async function createDemandRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  values: DemandFormValues,
): Promise<DomainResult<BuyerDemand>> {
  const gate = authorizeAction(user, "create-demand");
  if (!gate.ok) return refused(gate.message);
  const draft = demandDraftFromForm(gate.user.id, values, "open");
  if (!draft.ok) return draft;
  return repository.createBuyerDemand(draft.value);
}

export async function updateDemandRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  id: string,
  values: DemandFormValues,
  status: BuyerDemandStatus,
): Promise<DomainResult<BuyerDemand>> {
  const current = await repository.getBuyerDemand(id);
  if (!current.ok) return current;
  const gate = authorizeOwnRecord(user, "edit-demand", current.value.buyerId);
  if (!gate.ok) return refused(gate.message);
  if (!demandMoveAllowed(current.value.status, status)) {
    return failure("conflict", demandLockedMessage(current.value.status));
  }
  const draft = demandDraftFromForm(current.value.buyerId, values, status);
  if (!draft.ok) return draft;
  return repository.updateBuyerDemand(id, {
    requestedQuantity: draft.value.requestedQuantity,
    preferredLocation: draft.value.preferredLocation,
    collectionWindow: draft.value.collectionWindow,
    indicativePriceKshPerKg: draft.value.indicativePriceKshPerKg,
    status,
  });
}

export function listingMoveAllowed(from: ListingStatus, to: ListingStatus): boolean {
  return LISTING_MOVES[from].includes(to);
}

export function demandMoveAllowed(from: BuyerDemandStatus, to: BuyerDemandStatus): boolean {
  return DEMAND_MOVES[from].includes(to);
}

export function listingLockedMessage(status: ListingStatus): string {
  if (status === "closed") return "This listing is closed and can no longer be changed.";
  if (status === "withdrawn") return "This listing was withdrawn and can no longer be changed.";
  return "That listing status cannot be used from here.";
}

export function demandLockedMessage(status: BuyerDemandStatus): string {
  if (status === "closed") return "This requirement is closed and can no longer be changed.";
  if (status === "withdrawn") return "This requirement was withdrawn and can no longer be changed.";
  return "That requirement status cannot be used from here.";
}

export function canEditListing(status: ListingStatus): boolean {
  return LISTING_MOVES[status].length > 0;
}

export function canEditDemand(status: BuyerDemandStatus): boolean {
  return DEMAND_MOVES[status].length > 0;
}

export function listingsForAccount(listings: readonly Listing[], accountId: string): Listing[] {
  return listings.filter((listing) => listing.ownerId === accountId);
}

export function demandsForAccount(demands: readonly BuyerDemand[], accountId: string): BuyerDemand[] {
  return demands.filter((demand) => demand.buyerId === accountId);
}

/** Sum of open quantities. Null means none of that kind are open, which is different from a recorded zero. */
export function openQuantity(listings: readonly Listing[], kind: Listing["quantityKind"]): number | null {
  const matching = listings.filter((listing) => listing.status === "open" && listing.quantityKind === kind);
  if (matching.length === 0) return null;
  return matching.reduce((total, listing) => total + listing.quantity, 0);
}

export async function recordConfirmedCommitment(
  repository: CoordinationRepository,
  user: SessionUser | null,
  values: CommitmentFormValues,
): Promise<DomainResult<Commitment>> {
  const gate = authorizeAction(user, "create-commitment");
  if (!gate.ok) return refused(gate.message);
  if (values.listingId.trim() === "") return failure("invalid", "Choose a listing.");
  if (values.buyerDemandId.trim() === "") return failure("invalid", "Choose a purchasing requirement.");

  const listing = await repository.getListing(values.listingId);
  if (!listing.ok) return failure("not-found", "Choose a listing that is already saved.");
  const demand = await repository.getBuyerDemand(values.buyerDemandId);
  if (!demand.ok) return failure("not-found", "Choose a purchasing requirement that is already saved.");
  const party = commitmentParty(gate.user, listing.value, demand.value);
  if (!party.ok) return party;

  const blocked = agreementBlock(listing.value, demand.value);
  if (blocked) return failure("relationship", blocked);

  const draft = commitmentDraftFromForm(values);
  if (!draft.ok) return draft;

  const [commitments, purchases] = await Promise.all([repository.listCommitments(), repository.listPurchases()]);
  if (!commitments.ok) return commitments;
  if (!purchases.ok) return purchases;
  const listingLeft = remainingListingKg(listing.value, commitments.value, purchases.value);
  const demandLeft = remainingDemandKg(demand.value, commitments.value, purchases.value);
  if (grams(draft.value.agreedQuantity) > grams(listingLeft)) {
    return failure("relationship", quantityLeftMessage("listing", listingLeft));
  }
  if (grams(draft.value.agreedQuantity) > grams(demandLeft)) {
    return failure("relationship", quantityLeftMessage("requirement", demandLeft));
  }
  return repository.recordCommitment(draft.value);
}

export async function confirmProposedCommitment(
  repository: CoordinationRepository,
  user: SessionUser | null,
  id: string,
): Promise<DomainResult<Commitment>> {
  const current = await loadCommitmentParty(repository, user, "create-commitment", id);
  if (!current.ok) return current;
  if (current.value.commitment.status !== "proposed") {
    return failure("conflict", "Only a proposed agreement can be confirmed.");
  }
  return repository.updateCommitment(id, { status: "confirmed" });
}

export async function cancelCommitmentRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  id: string,
): Promise<DomainResult<Commitment>> {
  const current = await loadCommitmentParty(repository, user, "cancel-commitment", id);
  if (!current.ok) return current;
  const status = current.value.commitment.status;
  if (status !== "proposed" && status !== "confirmed") {
    return failure("conflict", "This agreement can no longer be cancelled.");
  }
  const purchases = await repository.listPurchases();
  if (!purchases.ok) return purchases;
  if (purchases.value.some((purchase) => purchase.commitmentId === id)) {
    return failure("relationship", "This agreement has a recorded purchase, so it cannot be cancelled.");
  }
  return repository.updateCommitment(id, { status: "cancelled" });
}

const OUTCOME_CATEGORIES = ["sold", "recovered", "spoiled", "donated", "disposed"] as const;

export async function recordOutcomeRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  values: OutcomeFormValues,
): Promise<DomainResult<Outcome>> {
  const gate = authorizeAction(user, "record-outcome");
  if (!gate.ok) return refused(gate.message);
  if (values.listingId.trim() === "") return failure("invalid", "Choose a listing.");
  const listing = await repository.getListing(values.listingId);
  if (!listing.ok) return failure("not-found", "Choose a listing that is already saved.");
  if (listing.value.ownerId !== gate.user.id) return refused(belongsToSomeoneElse(gate.user, "listing"));
  if (!isOutcomeCategory(values.category)) return failure("invalid", "Choose what happened to this produce.");

  const [outcomes, purchases] = await Promise.all([repository.listOutcomes(), repository.listPurchases()]);
  if (!outcomes.ok) return outcomes;
  if (!purchases.ok) return purchases;
  const links = outcomeLinks(values, purchases.value, listing.value.id);
  if (!links.ok) return links;
  const draft = outcomeDraftFromForm(values, links.value.purchaseId, links.value.commitmentId);
  if (!draft.ok) return draft;
  const blocked = outcomeBlock(
    listing.value,
    {
      listingId: listing.value.id,
      category: links.value.category,
      quantity: draft.value.quantity,
      purchaseId: links.value.purchaseId,
      commitmentId: links.value.commitmentId,
      recordedDate: draft.value.recordedDate,
      notes: draft.value.notes,
    },
    outcomes.value,
    purchases.value,
  );
  if (blocked) return failure("relationship", blocked);
  return repository.recordOutcome(draft.value);
}

function outcomeLinks(
  values: OutcomeFormValues,
  purchases: readonly Purchase[],
  listingId: string,
): DomainResult<{ category: OutcomeCategory; purchaseId: string | null; commitmentId: string | null }> {
  const category = values.category as OutcomeCategory;
  if (category !== "sold") return success({ category, purchaseId: null, commitmentId: null });
  if (values.saleKind === "external") return success({ category, purchaseId: null, commitmentId: null });
  if (values.saleKind !== "purchase") {
    return failure("invalid", "Choose whether this sale is a saved purchase or a sale outside Nyuma.");
  }
  const purchase = purchases.find((item) => item.id === values.purchaseId);
  if (!purchase || purchase.listingId !== listingId) {
    return failure("invalid", "Choose a purchase recorded against this listing.");
  }
  return success({ category, purchaseId: purchase.id, commitmentId: purchase.commitmentId });
}

function isOutcomeCategory(value: string): value is OutcomeCategory {
  return OUTCOME_CATEGORIES.some((category) => category === value);
}

export async function recordPurchaseRecord(
  repository: CoordinationRepository,
  user: SessionUser | null,
  commitmentId: string,
  values: PurchaseFormValues,
): Promise<DomainResult<Purchase>> {
  const current = await loadCommitmentParty(repository, user, "record-purchase", commitmentId);
  if (!current.ok) return current;
  if (current.value.commitment.status !== "confirmed") {
    return failure(
      "relationship",
      `Record a purchase only against a confirmed agreement. This agreement is ${current.value.commitment.status}.`,
    );
  }
  const draft = purchaseDraftFromForm(current.value.commitment.id, current.value.commitment.listingId, values);
  if (!draft.ok) return draft;
  const purchases = await repository.listPurchases();
  if (!purchases.ok) return purchases;
  const left = remainingCommitmentKg(current.value.commitment, purchases.value);
  if (grams(draft.value.actualQuantity) > grams(left)) {
    return failure("relationship", quantityLeftMessage("agreement", left));
  }
  return repository.recordPurchase(draft.value);
}

async function loadCommitmentParty(
  repository: CoordinationRepository,
  user: SessionUser | null,
  action: "create-commitment" | "cancel-commitment" | "record-purchase",
  id: string,
): Promise<DomainResult<{ commitment: Commitment; listing: Listing; demand: BuyerDemand }>> {
  const gate = authorizeAction(user, action);
  if (!gate.ok) return refused(gate.message);
  const commitment = await repository.getCommitment(id);
  if (!commitment.ok) return failure("not-found", "Choose an agreement that is already saved.");
  const listing = await repository.getListing(commitment.value.listingId);
  if (!listing.ok) return failure("not-found", "The listing for this agreement could not be found.");
  const demand = await repository.getBuyerDemand(commitment.value.buyerDemandId);
  if (!demand.ok) return failure("not-found", "The requirement for this agreement could not be found.");
  const party = commitmentParty(gate.user, listing.value, demand.value);
  if (!party.ok) return party;
  return success({ commitment: commitment.value, listing: listing.value, demand: demand.value });
}

function commitmentParty(user: SessionUser, listing: Listing, demand: BuyerDemand): DomainResult<SessionUser> {
  if (user.role === "buyer") {
    if (demand.buyerId !== user.id) return refused(belongsToSomeoneElse(user, "requirement"));
    return success(user);
  }
  if (user.role === "farmer" || user.role === "trader") {
    if (listing.ownerId !== user.id) return refused(belongsToSomeoneElse(user, "listing"));
    return success(user);
  }
  return refused(
    user.sample
      ? "The sample administrator account cannot change an agreement or a purchase."
      : "The administrator role cannot change an agreement or a purchase.",
  );
}

function belongsToSomeoneElse(user: SessionUser, record: "listing" | "requirement"): string {
  const owner = user.sample ? "another sample account" : "another account";
  return record === "listing" ? `This listing belongs to ${owner}.` : `This requirement belongs to ${owner}.`;
}

function quantityLeftMessage(kind: "listing" | "requirement" | "agreement", left: number): string {
  if (left <= 0) {
    if (kind === "listing") return "This listing has no quantity left to agree.";
    if (kind === "requirement") return "This requirement has no quantity left to agree.";
    return "This agreement has no quantity left to purchase.";
  }
  const amount = trimKg(left);
  if (kind === "listing") return `This listing only has ${amount} left to agree.`;
  if (kind === "requirement") return `This requirement only has ${amount} left to agree.`;
  return `This agreement only has ${amount} left to purchase.`;
}

function grams(quantity: number): number {
  return Math.round(quantity * 1000);
}

function trimKg(quantity: number): string {
  return `${quantity.toFixed(3).replace(/\.?0+$/, "")} kg`;
}

export function openRequestedQuantity(demands: readonly BuyerDemand[]): number | null {
  const matching = demands.filter((demand) => demand.status === "open");
  if (matching.length === 0) return null;
  return matching.reduce((total, demand) => total + demand.requestedQuantity, 0);
}
