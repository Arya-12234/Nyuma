import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../domain/records";
import { matchListingToDemand } from "../domain/matchListing";
import {
  agreementBlock,
  commitmentsForSide,
  confirmedCommitmentCount,
  confirmedQuantityKg,
  purchasedQuantityKg,
  purchasesForCommitments,
} from "./coordinationActivity";
import { listingsForAccount, openQuantity } from "./coordinationWorkflow";
import { outcomeSummary, type OutcomeSummary } from "./outcomeAccounting";
import { exposureReport } from "./surplus";

/**
 * Trader-facing totals. Supply kinds come from openQuantity.
 * Confirmed quantity and purchase quantity use the existing hold and
 * purchase helpers. Exposure comes from exposureReport.
 * Nothing here writes a listing, agreement, purchase, or outcome.
 */

export const MATCH_LABEL = "Potential match — agreement not confirmed";

export const TRADER_EXPLANATIONS = {
  availableNow: "Available now: produce the listing owner has marked ready for collection.",
  expectedHarvest: "Expected harvest: produce anticipated but not yet ready for collection.",
  potentialMatch: "Potential match: a compatibility suggestion, not an agreement.",
  committed: "Committed: quantity covered by a confirmed agreement. This is not a sale.",
  purchased: "Purchased: quantity recorded as actually bought. An agreement is not counted again.",
  exposed:
    "Still exposed: available produce not yet recorded as purchased or otherwise accounted for under the existing surplus calculation.",
  unaccounted: "Unaccounted: quantity without a recorded outcome. It does not mean spoiled.",
  requirement: "A buyer requirement is an expression of interest, not a confirmed order.",
  indicativePrice: "An indicative price is not a guaranteed price.",
} as const;

export interface TraderRecordSet {
  listings: readonly Listing[];
  demands: readonly BuyerDemand[];
  commitments: readonly Commitment[];
  purchases: readonly Purchase[];
  outcomes: readonly Outcome[];
}

export interface TraderOverview {
  openListingCount: number;
  listedKg: number | null;
  availableNowKg: number | null;
  expectedHarvestKg: number | null;
  draftCount: number;
  compatibleRequirementCount: number;
  proposedCount: number;
  confirmedCount: number;
  confirmedKg: number | null;
  cancelledCount: number;
  fulfilledCount: number;
  purchaseCount: number;
  purchasedKg: number | null;
  exposedKg: number;
  upcomingKg: number;
}

export interface TraderMatchSuggestion {
  demandId: string;
  buyerId: string;
  commodity: Listing["commodity"];
  listingQuantityKg: number;
  requirementQuantityKg: number;
  suggestedKg: number;
  indicativePriceKsh: number;
  unallocatedKg: number;
  why: string;
  label: typeof MATCH_LABEL;
  planning: boolean;
}

export interface TraderMatchGap {
  demandId: string;
  buyerId: string;
  commodity: Listing["commodity"];
  why: string;
}

export interface TraderListingMatch {
  listingId: string;
  commodity: Listing["commodity"];
  quantityKind: Listing["quantityKind"];
  quantity: number;
  status: Listing["status"];
  planning: boolean;
  suggestions: TraderMatchSuggestion[];
  incompatible: TraderMatchGap[];
  unallocatedKg: number | null;
  indicativeGrossSalesKsh: number | null;
  explanation: string | null;
}

export function summarizeTrader(accountId: string, records: TraderRecordSet): TraderOverview {
  const owned = listingsForAccount(records.listings, accountId);
  const open = owned.filter((listing) => listing.status === "open");
  const availableNowKg = openQuantity(owned, "available");
  const expectedHarvestKg = openQuantity(owned, "expected");
  const agreements = commitmentsForSide(records.commitments, owned, records.demands, accountId, "listing");
  const purchases = purchasesForCommitments(records.purchases, agreements);
  const exposure = exposureReport({
    listings: records.listings,
    demands: records.demands,
    commitments: records.commitments,
    purchases: records.purchases,
    outcomes: records.outcomes,
    audience: "trader",
    accountId,
  });

  return {
    openListingCount: open.length,
    listedKg: addKg(availableNowKg, expectedHarvestKg),
    availableNowKg,
    expectedHarvestKg,
    draftCount: owned.filter((listing) => listing.status === "draft").length,
    compatibleRequirementCount: compatibleCount(open, records.demands),
    proposedCount: agreements.filter((item) => item.status === "proposed").length,
    confirmedCount: confirmedCommitmentCount(agreements),
    confirmedKg: confirmedQuantityKg(agreements),
    cancelledCount: agreements.filter((item) => item.status === "cancelled").length,
    fulfilledCount: agreements.filter((item) => item.status === "fulfilled").length,
    purchaseCount: purchases.length,
    purchasedKg: purchasedQuantityKg(purchases),
    exposedKg: exposure.summary.exposedKg,
    upcomingKg: exposure.summary.upcomingKg,
  };
}

export function traderOutcomeSummary(accountId: string, records: TraderRecordSet): OutcomeSummary {
  return outcomeSummary(listingsForAccount(records.listings, accountId), records.outcomes, records.purchases);
}

/** Suggestions for this trader's listings. Closed records are not allocated. */
export function matchTraderListings(
  accountId: string,
  listings: readonly Listing[],
  demands: readonly BuyerDemand[],
): TraderListingMatch[] {
  return listingsForAccount(listings, accountId).map((listing) => matchOne(listing, demands));
}

function matchOne(listing: Listing, demands: readonly BuyerDemand[]): TraderListingMatch {
  const planning = listing.quantityKind === "expected";
  const base = {
    listingId: listing.id,
    commodity: listing.commodity,
    quantityKind: listing.quantityKind,
    quantity: listing.quantity,
    status: listing.status,
    planning,
  };
  if (listing.status !== "open") {
    return {
      ...base,
      suggestions: [],
      incompatible: [],
      unallocatedKg: null,
      indicativeGrossSalesKsh: null,
      explanation: `This listing is ${listing.status}. Only an open listing is compared with buyer requirements.`,
    };
  }

  const openDemands = demands.filter((demand) => demand.status === "open");
  const result = matchListingToDemand(listing, openDemands);
  if (!result.ok) {
    return {
      ...base,
      suggestions: [],
      incompatible: [],
      unallocatedKg: null,
      indicativeGrossSalesKsh: null,
      explanation: result.message,
    };
  }

  const { decision } = result.value;
  const suggestions: TraderMatchSuggestion[] = [];
  const incompatible: TraderMatchGap[] = [];
  for (const allocation of decision.allocations) {
    if (allocation.allocatedKg > 0) {
      suggestions.push({
        demandId: allocation.buyerId,
        buyerId: allocation.buyerName,
        commodity: allocation.produce,
        listingQuantityKg: listing.quantity,
        requirementQuantityKg: allocation.requestedKg,
        suggestedKg: allocation.allocatedKg,
        indicativePriceKsh: allocation.indicativePriceKsh,
        unallocatedKg: decision.metrics.unallocatedKg,
        why: allocation.allocationNote
          ? `${compatibleWhy(planning)} ${allocation.allocationNote}`
          : compatibleWhy(planning),
        label: MATCH_LABEL,
        planning,
      });
      continue;
    }
    if (!allocation.eligible) {
      incompatible.push({
        demandId: allocation.buyerId,
        buyerId: allocation.buyerName,
        commodity: allocation.produce,
        why: allocation.reasons.join(" ") || allocation.statusLabel,
      });
    }
  }

  return {
    ...base,
    suggestions,
    incompatible,
    unallocatedKg: decision.metrics.unallocatedKg,
    indicativeGrossSalesKsh: decision.metrics.indicativeGrossSalesKsh,
    explanation: planning
      ? "Planning suggestion. This expected harvest is not ready for collection, and a suggestion is not an agreement."
      : null,
  };
}

function compatibleWhy(planning: boolean): string {
  const fit = "The produce matches and the collection window fits.";
  return planning
    ? `${fit} This is a planning suggestion for an expected harvest, not produce ready to collect.`
    : `${fit} This is a suggestion, not an agreement.`;
}

function compatibleCount(listings: readonly Listing[], demands: readonly BuyerDemand[]): number {
  return demands.filter(
    (demand) => demand.status === "open" && listings.some((listing) => agreementBlock(listing, demand) === null),
  ).length;
}

function addKg(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return fromMilli(milli(left ?? 0) + milli(right ?? 0));
}

function milli(quantity: number): number {
  return Math.round(quantity * 1000);
}

function fromMilli(quantityMilli: number): number {
  return quantityMilli / 1000;
}
