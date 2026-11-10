import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../domain/records";
import { agreementBlock, heldDemandKg, heldListingKg, remainingCommitmentKg } from "./coordinationActivity";

/**
 * Surplus figures are derived. They are not stored.
 *
 * For one listing:
 *   listedKg = listing.quantity
 *   heldKg = the existing hold rule
 *     proposed or confirmed: agreed quantity
 *     fulfilled: purchased quantity on that agreement only
 *     cancelled: 0
 *   purchasedKg = each purchase on this listing, once, by listing id
 *   notYetPurchasedKg = listedKg − purchasedKg
 *   uncommittedKg = listedKg − heldKg
 *   exposedKg, for an open listing marked available now:
 *     notYetPurchasedKg minus outcomes that are not linked to a purchase
 *     A held agreement is not subtracted again. A sold outcome linked to a
 *     purchase is not subtracted again, because that purchase is already
 *     inside notYetPurchasedKg. A confirmed agreement is not a sale.
 *   exposedKg, for an expected harvest, or for a listing that is not open:
 *     null
 *     The record does not say how much is ready to collect.
 *
 * Compatible requirements use the existing produce and collection-window check.
 * A demonstration-scenario match is not consulted.
 */

export type ExposureAudience = "farmer" | "trader" | "buyer" | "administrator";

export interface ListingExposure {
  listingId: string;
  listedKg: number;
  heldKg: number;
  confirmedKg: number;
  proposedKg: number;
  purchasedKg: number;
  notYetPurchasedKg: number;
  uncommittedKg: number;
  /**
   * Recovered, spoiled, donated, disposed, or sold with no purchase link.
   * A sold outcome that points at a purchase is excluded, because that purchase
   * is already in purchasedKg.
   */
  settledOutsidePurchaseKg: number;
  /** Null when the listing is not ready-to-collect produce. */
  exposedKg: number | null;
  compatibleOpenDemand: boolean;
}

export interface DemandExposure {
  demandId: string;
  requestedKg: number;
  heldKg: number;
  remainingKg: number;
}

export interface ExposureSummary {
  availableUnconfirmedCount: number;
  partialCount: number;
  purchasedKg: number;
  exposedKg: number;
  upcomingKg: number;
}

export interface CoordinationAlert {
  id: string;
  tone: "warning" | "info";
  subjectId: string;
  detected: string;
  quantityKg: number | null;
  why: string;
  action: string;
}

export interface ExposureReport {
  upcoming: ListingExposure[];
  available: ListingExposure[];
  demands: DemandExposure[];
  summary: ExposureSummary;
  alerts: CoordinationAlert[];
}

export function listingExposure(
  listing: Listing,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
  demands: readonly BuyerDemand[],
  outcomes: readonly Outcome[] = [],
): ListingExposure {
  const mine = commitments.filter((item) => item.listingId === listing.id);
  const purchasedKg = sum(purchases.filter((item) => item.listingId === listing.id).map((item) => item.actualQuantity));
  const heldKg = heldListingKg(listing.id, commitments, purchases);
  const settledOutsidePurchaseKg = sum(
    outcomes
      .filter((outcome) => outcome.listingId === listing.id && outcome.purchaseId === null)
      .map((outcome) => outcome.quantity),
  );
  const notYetPurchasedKg = sub(listing.quantity, purchasedKg);
  const ready = listing.status === "open" && listing.quantityKind === "available";
  return {
    listingId: listing.id,
    listedKg: listing.quantity,
    heldKg,
    confirmedKg: sum(mine.filter((item) => item.status === "confirmed").map((item) => item.agreedQuantity)),
    proposedKg: sum(mine.filter((item) => item.status === "proposed").map((item) => item.agreedQuantity)),
    purchasedKg,
    notYetPurchasedKg,
    uncommittedKg: sub(listing.quantity, heldKg),
    settledOutsidePurchaseKg,
    exposedKg: ready ? sub(notYetPurchasedKg, settledOutsidePurchaseKg) : null,
    compatibleOpenDemand: demands.some((demand) => agreementBlock(listing, demand) === null),
  };
}

export function demandExposure(
  demand: BuyerDemand,
  commitments: readonly Commitment[],
  purchases: readonly Purchase[],
): DemandExposure {
  const heldKg = heldDemandKg(demand.id, commitments, purchases);
  return {
    demandId: demand.id,
    requestedKg: demand.requestedQuantity,
    heldKg,
    remainingKg: sub(demand.requestedQuantity, heldKg),
  };
}

export function exposureReport(input: {
  listings: readonly Listing[];
  demands: readonly BuyerDemand[];
  commitments: readonly Commitment[];
  purchases: readonly Purchase[];
  outcomes?: readonly Outcome[];
  audience: ExposureAudience;
  accountId: string;
}): ExposureReport {
  const outcomes = input.outcomes ?? [];
  const listings = visibleListings(input);
  const exposures = listings.map((listing) =>
    listingExposure(listing, input.commitments, input.purchases, input.demands, outcomes),
  );
  const byId = new Map(exposures.map((item) => [item.listingId, item]));
  const demands = visibleDemands(input).map((demand) => demandExposure(demand, input.commitments, input.purchases));
  const available = exposures.filter((item) => {
    const listing = listings.find((candidate) => candidate.id === item.listingId);
    return listing?.quantityKind === "available";
  });
  const upcoming = exposures.filter((item) => {
    const listing = listings.find((candidate) => candidate.id === item.listingId);
    return listing?.quantityKind === "expected";
  });
  return {
    upcoming,
    available,
    demands,
    summary: summarize(available, upcoming),
    alerts: dedupe(alertsFor(input, byId)),
  };
}

function visibleListings(input: {
  listings: readonly Listing[];
  audience: ExposureAudience;
  accountId: string;
}): Listing[] {
  return input.listings.filter((listing) => {
    if (listing.status !== "open") return false;
    if (input.audience === "buyer") return false;
    if (input.audience === "administrator") return true;
    return listing.ownerId === input.accountId;
  });
}

function visibleDemands(input: {
  demands: readonly BuyerDemand[];
  audience: ExposureAudience;
  accountId: string;
}): BuyerDemand[] {
  return input.demands.filter((demand) => {
    if (demand.status !== "open") return false;
    if (input.audience === "farmer" || input.audience === "trader") return false;
    if (input.audience === "administrator") return true;
    return demand.buyerId === input.accountId;
  });
}

function summarize(available: readonly ListingExposure[], upcoming: readonly ListingExposure[]): ExposureSummary {
  return {
    availableUnconfirmedCount: available.filter((item) => item.confirmedKg === 0).length,
    partialCount: available.filter((item) => item.confirmedKg > 0 && item.confirmedKg < item.listedKg).length,
    purchasedKg: sum(available.map((item) => item.purchasedKg)),
    exposedKg: sum(available.map((item) => item.exposedKg ?? 0)),
    upcomingKg: sum(upcoming.map((item) => item.listedKg)),
  };
}

function alertsFor(
  input: {
    listings: readonly Listing[];
    demands: readonly BuyerDemand[];
    commitments: readonly Commitment[];
    purchases: readonly Purchase[];
    audience: ExposureAudience;
    accountId: string;
  },
  byId: Map<string, ListingExposure>,
): CoordinationAlert[] {
  const alerts: CoordinationAlert[] = [];
  for (const listing of visibleListings(input)) {
    const exposure = byId.get(listing.id);
    if (!exposure) continue;
    alerts.push(...listingAlerts(listing, exposure));
    for (const commitment of input.commitments.filter((item) => item.listingId === listing.id)) {
      const alert = commitmentAlert(listing, commitment, input.purchases);
      if (alert) alerts.push(alert);
    }
  }
  if (input.audience === "buyer" || input.audience === "administrator") {
    for (const demand of visibleDemands(input)) {
      const exposure = demandExposure(demand, input.commitments, input.purchases);
      if (exposure.remainingKg > 0) alerts.push(demandAlert(demand, exposure.remainingKg));
    }
  }
  if (input.audience === "buyer") {
    const ownDemandIds = new Set(input.demands.filter((demand) => demand.buyerId === input.accountId).map((demand) => demand.id));
    for (const commitment of input.commitments.filter((item) => ownDemandIds.has(item.buyerDemandId))) {
      const listing = input.listings.find((item) => item.id === commitment.listingId);
      if (!listing) continue;
      const alert = commitmentAlert(listing, commitment, input.purchases);
      if (alert) alerts.push(alert);
    }
  }
  const unique = dedupe(alerts);
  return input.audience === "administrator" ? unique.map(readOnly) : unique;
}

function listingAlerts(listing: Listing, exposure: ListingExposure): CoordinationAlert[] {
  if (listing.quantityKind === "expected") {
    return [expectedAlert(listing, exposure)];
  }
  if (exposure.confirmedKg === 0 && exposure.proposedKg === 0 && exposure.heldKg === 0) {
    if (exposure.exposedKg === 0) return [];
    return [uncommittedAlert(listing, exposure)];
  }
  if (exposure.confirmedKg === 0 && exposure.proposedKg > 0 && exposure.uncommittedKg === 0) {
    return [proposedAlert(listing, exposure)];
  }
  if (exposure.uncommittedKg > 0 && exposure.exposedKg !== 0) {
    return [partialAlert(listing, exposure)];
  }
  return [];
}

function expectedAlert(listing: Listing, exposure: ListingExposure): CoordinationAlert {
  const fit = exposure.compatibleOpenDemand
    ? "Review the expected collection date on any agreement."
    : "No open buyer requirement fits this harvest window. Review the expected collection date on any agreement.";
  return {
    id: `expected-harvest:${listing.id}`,
    tone: "info",
    subjectId: listing.id,
    detected: `${listing.commodity} is an expected harvest.`,
    quantityKg: exposure.listedKg,
    why: "Upcoming supply is not ready for collection. Nyuma cannot calculate a ready-to-collect surplus from an expected harvest.",
    action: `Update the listing when the produce is ready to collect. ${fit}`,
  };
}

function uncommittedAlert(listing: Listing, exposure: ListingExposure): CoordinationAlert {
  const noFit = !exposure.compatibleOpenDemand;
  return {
    id: `available-uncommitted:${listing.id}`,
    tone: "warning",
    subjectId: listing.id,
    detected: noFit
      ? `${listing.commodity} is available now, has no confirmed agreement, and no open buyer requirement fits its produce and collection window.`
      : `${listing.commodity} is available now and has no confirmed agreement.`,
    quantityKg: exposure.exposedKg,
    why: "A possible match is not an agreement. This quantity can remain unsold.",
    action: noFit
      ? "Update the available quantity or collection window if they have changed. This page does not contact buyers."
      : "Review open buyer requirements that fit this produce and collection window. Record an agreement only after both sides have agreed.",
  };
}

function partialAlert(listing: Listing, exposure: ListingExposure): CoordinationAlert {
  const proposed =
    exposure.proposedKg > 0 ? ` ${kg(exposure.proposedKg)} is only proposed, which is not a confirmed agreement.` : "";
  const noFit = !exposure.compatibleOpenDemand ? " No open buyer requirement fits this produce and collection window." : "";
  return {
    id: `partial-commitment:${listing.id}`,
    tone: "warning",
    subjectId: listing.id,
    detected: `Part of the available ${listing.commodity} has no agreement.${proposed}${noFit}`,
    quantityKg: exposure.uncommittedKg,
    why: "The quantity held by an agreement stays reserved. The rest can remain unsold.",
    action: exposure.compatibleOpenDemand
      ? "Review open buyer requirements for the remaining quantity. Record an agreement only after both sides have agreed."
      : "Update the available quantity if it has changed. This page does not contact buyers.",
  };
}

function proposedAlert(listing: Listing, exposure: ListingExposure): CoordinationAlert {
  return {
    id: `proposed-only:${listing.id}`,
    tone: "info",
    subjectId: listing.id,
    detected: `${listing.commodity} has a proposed agreement. That is not a confirmed allocation.`,
    quantityKg: exposure.proposedKg,
    why: "The quantity is held aside, and it has not been agreed as a confirmed commitment.",
    action: "Confirm the agreement only after both sides have agreed.",
  };
}

function commitmentAlert(listing: Listing, commitment: Commitment, purchases: readonly Purchase[]): CoordinationAlert | null {
  if (commitment.status !== "confirmed") return null;
  const left = remainingCommitmentKg(commitment, purchases);
  if (left <= 0) return null;
  const bought = sum(purchases.filter((item) => item.commitmentId === commitment.id).map((item) => item.actualQuantity));
  const harvest = listing.quantityKind === "expected";
  return {
    id: `commitment-unpurchased:${commitment.id}`,
    tone: bought === 0 ? "warning" : "info",
    subjectId: commitment.id,
    detected:
      bought === 0
        ? `The confirmed ${listing.commodity} agreement has no recorded purchase.`
        : `Part of the confirmed ${listing.commodity} agreement has no recorded purchase.`,
    quantityKg: left,
    why: harvest
      ? "An agreement is not a purchase. This listing is an expected harvest, not produce ready to collect. This is not a spoilage warning."
      : "An agreement is not a purchase. The remaining quantity has not been recorded as bought. This is not a spoilage warning.",
    action:
      "Record a purchase after a real transaction, or review the expected collection date. Speak with the buyer on the agreement. This page does not send a message or create a purchase.",
  };
}

function readOnly(alert: CoordinationAlert): CoordinationAlert {
  return {
    ...alert,
    action: "Review the saved record. This page cannot change a listing, an agreement, or a purchase.",
  };
}

function demandAlert(demand: BuyerDemand, remainingKg: number): CoordinationAlert {
  return {
    id: `demand-remaining:${demand.id}`,
    tone: "info",
    subjectId: demand.id,
    detected: `The ${demand.commodity} requirement still has quantity with no agreement.`,
    quantityKg: remainingKg,
    why: "The uncommitted part is not an order and is not a sale.",
    action: "Review produce that is available now. Record an agreement only after you have actually agreed.",
  };
}

function dedupe(alerts: readonly CoordinationAlert[]): CoordinationAlert[] {
  const seen = new Set<string>();
  const unique: CoordinationAlert[] = [];
  for (const alert of alerts) {
    if (seen.has(alert.id)) continue;
    seen.add(alert.id);
    unique.push(alert);
  }
  return unique.sort((a, b) => {
    if (a.tone !== b.tone) return a.tone === "warning" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 1000), 0) / 1000;
}

function sub(total: number, used: number): number {
  return Math.max(0, Math.round(total * 1000) - Math.round(used * 1000)) / 1000;
}

function kg(quantity: number): string {
  return `${quantity.toFixed(3).replace(/\.?0+$/, "")} kg`;
}
