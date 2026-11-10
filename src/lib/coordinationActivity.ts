import type { BuyerDemand, Commitment, Listing, Purchase } from "../domain/records";
import { isTimeCompatible } from "./decisionEngine";

/**
 * Quantity still spoken for, using the same rule as the stored relationship checks:
 * a proposed or confirmed agreement holds its agreed quantity;
 * a fulfilled agreement holds only what was purchased;
 * a cancelled agreement holds nothing.
 */

export function heldListingKg(
  listingId: string,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
): number {
  return fromMilli(heldMilli(commitments.filter((item) => item.listingId === listingId), purchases));
}

export function heldDemandKg(
  buyerDemandId: string,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
): number {
  return fromMilli(heldMilli(commitments.filter((item) => item.buyerDemandId === buyerDemandId), purchases));
}

export function remainingListingKg(
  listing: Listing,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
): number {
  return fromMilli(Math.max(0, milli(listing.quantity) - milli(heldListingKg(listing.id, commitments, purchases))));
}

export function remainingDemandKg(
  demand: BuyerDemand,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
): number {
  return fromMilli(
    Math.max(0, milli(demand.requestedQuantity) - milli(heldDemandKg(demand.id, commitments, purchases))),
  );
}

export function remainingCommitmentKg(commitment: Commitment, purchases: readonly Purchase[]): number {
  return fromMilli(Math.max(0, milli(commitment.agreedQuantity) - purchasedMilli(purchases, commitment.id)));
}

/** Confirmed agreements only. Proposed, fulfilled, and cancelled quantities are not included. */
export function confirmedQuantityKg(commitments: readonly Commitment[]): number | null {
  const confirmed = commitments.filter((item) => item.status === "confirmed");
  if (confirmed.length === 0) return null;
  return fromMilli(confirmed.reduce((total, item) => total + milli(item.agreedQuantity), 0));
}

export function confirmedCommitmentCount(commitments: readonly Commitment[]): number {
  return commitments.filter((item) => item.status === "confirmed").length;
}

/** Each purchase is counted once. A confirmed agreement is not added again. */
export function purchasedQuantityKg(purchases: readonly Purchase[]): number | null {
  if (purchases.length === 0) return null;
  return fromMilli(purchases.reduce((total, item) => total + milli(item.actualQuantity), 0));
}

export function commitmentsForSide(
  commitments: readonly Commitment[],
  listings: readonly Listing[],
  demands: readonly BuyerDemand[],
  accountId: string,
  side: "listing" | "demand",
): Commitment[] {
  return commitments.filter((commitment) => {
    if (side === "listing") {
      return listings.some((listing) => listing.id === commitment.listingId && listing.ownerId === accountId);
    }
    return demands.some((demand) => demand.id === commitment.buyerDemandId && demand.buyerId === accountId);
  });
}

export function purchasesForCommitments(
  purchases: readonly Purchase[],
  commitments: readonly Commitment[],
): Purchase[] {
  const ids = new Set(commitments.map((commitment) => commitment.id));
  return purchases.filter((purchase) => ids.has(purchase.commitmentId));
}

/** Null when the listing and requirement can be agreed. Otherwise a reason to show the user. */
export function agreementBlock(listing: Listing, demand: BuyerDemand): string | null {
  if (listing.status !== "open") return "Record an agreement only while the listing is open.";
  if (demand.status !== "open") return "Record an agreement only while the requirement is open.";
  if (listing.commodity !== demand.commodity) {
    return `The listing is for ${listing.commodity} and the requirement is for ${demand.commodity}. An agreement needs the same produce.`;
  }
  if (!isTimeCompatible(listing.availabilityWindow, demand.collectionWindow)) {
    return `The requirement collects ${demand.collectionWindow}, which does not fit a listing window of ${listing.availabilityWindow}.`;
  }
  return null;
}

function heldMilli(commitments: readonly Commitment[], purchases: readonly Purchase[]): number {
  let held = 0;
  for (const commitment of commitments) {
    if (commitment.status === "proposed" || commitment.status === "confirmed") held += milli(commitment.agreedQuantity);
    else if (commitment.status === "fulfilled") held += purchasedMilli(purchases, commitment.id);
  }
  return held;
}

function purchasedMilli(purchases: readonly Purchase[], commitmentId: string): number {
  return purchases
    .filter((purchase) => purchase.commitmentId === commitmentId)
    .reduce((total, purchase) => total + milli(purchase.actualQuantity), 0);
}

function milli(quantity: number): number {
  return Math.round(quantity * 1000);
}

function fromMilli(quantityMilli: number): number {
  return quantityMilli / 1000;
}
