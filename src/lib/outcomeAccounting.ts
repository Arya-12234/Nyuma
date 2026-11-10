import type { BuyerDemand, Commitment, Listing, Outcome, OutcomeCategory, Purchase } from "../domain/records";

/**
 * Outcome quantities are checked before they are saved. Listing quantities and
 * purchases are not rewritten.
 *
 * Accounted kilograms on a listing:
 *   every saved outcome, once
 *   plus any purchase quantity that no sold outcome already points at
 * A sold outcome linked to a purchase covers that purchase. It does not add
 * the same kilograms a second time.
 * A sold outcome with no purchase is a sale outside Nyuma. It uses kilograms
 * that are still unaccounted for.
 * Recovered, spoiled, donated, and disposed outcomes also use unaccounted
 * kilograms. They cannot cover a purchase or another outcome.
 *
 * Unaccounted kilograms = listing quantity − accounted kilograms.
 * Kilograms with no outcome record = listing quantity − outcome quantities.
 * A purchase is not an outcome, so it can sit inside "no outcome record"
 * while still being accounted for.
 */

export const OUTCOME_LABELS: Record<OutcomeCategory, string> = {
  sold: "Sold",
  recovered: "Recovered through another buyer or market",
  spoiled: "Spoiled",
  donated: "Donated",
  disposed: "Disposed of",
};

export interface OutcomeInput {
  listingId: string;
  category: OutcomeCategory;
  quantity: number;
  purchaseId: string | null;
  commitmentId: string | null;
  recordedDate: string;
  notes: string;
}

export interface ListingOutcomeAccount {
  listedKg: number;
  soldKg: number;
  recoveredKg: number;
  spoiledKg: number;
  donatedKg: number;
  disposedKg: number;
  purchasedWithoutSoldOutcomeKg: number;
  noOutcomeKg: number;
  unaccountedKg: number;
}

export interface OutcomeSummary extends ListingOutcomeAccount {
  listingsWithOutcomes: number;
}

export function listingOutcomeAccount(
  listing: Listing,
  outcomes: readonly Outcome[],
  purchases: readonly Purchase[],
): ListingOutcomeAccount {
  const mine = outcomes.filter((outcome) => outcome.listingId === listing.id);
  const purchasedWithoutSoldOutcomeKg = kg(
    purchases
      .filter((purchase) => purchase.listingId === listing.id)
      .reduce((total, purchase) => total + uncoveredGrams(purchase, mine), 0),
  );
  const soldKg = categoryKg(mine, "sold");
  const recoveredKg = categoryKg(mine, "recovered");
  const spoiledKg = categoryKg(mine, "spoiled");
  const donatedKg = categoryKg(mine, "donated");
  const disposedKg = categoryKg(mine, "disposed");
  const outcomeGrams = mine.reduce((total, outcome) => total + grams(outcome.quantity), 0);
  return {
    listedKg: listing.quantity,
    soldKg,
    recoveredKg,
    spoiledKg,
    donatedKg,
    disposedKg,
    purchasedWithoutSoldOutcomeKg,
    noOutcomeKg: kg(Math.max(0, grams(listing.quantity) - outcomeGrams)),
    unaccountedKg: kg(Math.max(0, grams(listing.quantity) - outcomeGrams - grams(purchasedWithoutSoldOutcomeKg))),
  };
}

export function outcomeSummary(
  listings: readonly Listing[],
  outcomes: readonly Outcome[],
  purchases: readonly Purchase[],
): OutcomeSummary {
  const rows = listings.map((listing) => listingOutcomeAccount(listing, outcomes, purchases));
  const total = rows.reduce(
    (sum, row) => ({
      listedKg: kg(grams(sum.listedKg) + grams(row.listedKg)),
      soldKg: kg(grams(sum.soldKg) + grams(row.soldKg)),
      recoveredKg: kg(grams(sum.recoveredKg) + grams(row.recoveredKg)),
      spoiledKg: kg(grams(sum.spoiledKg) + grams(row.spoiledKg)),
      donatedKg: kg(grams(sum.donatedKg) + grams(row.donatedKg)),
      disposedKg: kg(grams(sum.disposedKg) + grams(row.disposedKg)),
      purchasedWithoutSoldOutcomeKg: kg(
        grams(sum.purchasedWithoutSoldOutcomeKg) + grams(row.purchasedWithoutSoldOutcomeKg),
      ),
      noOutcomeKg: kg(grams(sum.noOutcomeKg) + grams(row.noOutcomeKg)),
      unaccountedKg: kg(grams(sum.unaccountedKg) + grams(row.unaccountedKg)),
    }),
    emptyAccount(),
  );
  return {
    ...total,
    listingsWithOutcomes: listings.filter((listing) => outcomes.some((outcome) => outcome.listingId === listing.id)).length,
  };
}

/** Sold outcomes that point at this buyer's own purchases. Notes stay with the listing owner. */
export function outcomesForBuyer(
  buyerId: string,
  outcomes: readonly Outcome[],
  purchases: readonly Purchase[],
  commitments: readonly Commitment[],
  demands: readonly BuyerDemand[],
): Outcome[] {
  const ownDemands = new Set(demands.filter((demand) => demand.buyerId === buyerId).map((demand) => demand.id));
  const ownCommitments = new Set(
    commitments.filter((commitment) => ownDemands.has(commitment.buyerDemandId)).map((commitment) => commitment.id),
  );
  const ownPurchases = new Set(
    purchases.filter((purchase) => ownCommitments.has(purchase.commitmentId)).map((purchase) => purchase.id),
  );
  return outcomes.filter(
    (outcome) => outcome.category === "sold" && outcome.purchaseId !== null && ownPurchases.has(outcome.purchaseId),
  );
}

/** Why a new outcome cannot be saved, or null when the quantity fits. */
export function outcomeBlock(
  listing: Listing,
  draft: OutcomeInput,
  outcomes: readonly Outcome[],
  purchases: readonly Purchase[],
): string | null {
  const mine = outcomes.filter((outcome) => outcome.listingId === listing.id);
  if (mine.some((outcome) => sameOutcome(outcome, draft))) {
    return "This outcome is already saved. It was not recorded again.";
  }
  if (draft.purchaseId !== null) {
    const purchase = purchases.find((item) => item.id === draft.purchaseId);
    if (!purchase || purchase.listingId !== listing.id) {
      return "Choose a purchase recorded against this listing.";
    }
    if (draft.category !== "sold") return "A purchase can only be linked to a sold outcome.";
    if (draft.commitmentId !== null && draft.commitmentId !== purchase.commitmentId) {
      return "That agreement is not part of the selected purchase.";
    }
    const left = uncoveredGrams(purchase, mine);
    if (grams(draft.quantity) > left) {
      if (left <= 0) return "This purchase is already fully recorded as sold. It was not counted again.";
      return `This purchase only has ${trimKg(kg(left))} that is not already recorded as sold.`;
    }
    return null;
  }
  const left = grams(listingOutcomeAccount(listing, outcomes, purchases).unaccountedKg);
  if (grams(draft.quantity) > left) {
    if (left <= 0) {
      return "This listing has no quantity left to record. Purchased kilograms and saved outcomes already account for it.";
    }
    return `This listing only has ${trimKg(kg(left))} still unaccounted for. Purchased kilograms are already counted.`;
  }
  return null;
}

function sameOutcome(outcome: Outcome, draft: OutcomeInput): boolean {
  return (
    outcome.listingId === draft.listingId &&
    outcome.category === draft.category &&
    grams(outcome.quantity) === grams(draft.quantity) &&
    outcome.recordedDate === draft.recordedDate &&
    outcome.purchaseId === draft.purchaseId &&
    outcome.commitmentId === draft.commitmentId &&
    outcome.notes === draft.notes
  );
}

function uncoveredGrams(purchase: Purchase, outcomes: readonly Outcome[]): number {
  const linked = outcomes
    .filter((outcome) => outcome.purchaseId === purchase.id && outcome.category === "sold")
    .reduce((total, outcome) => total + grams(outcome.quantity), 0);
  return Math.max(0, grams(purchase.actualQuantity) - linked);
}

function categoryKg(outcomes: readonly Outcome[], category: OutcomeCategory): number {
  return kg(outcomes.filter((outcome) => outcome.category === category).reduce((total, outcome) => total + grams(outcome.quantity), 0));
}

function emptyAccount(): ListingOutcomeAccount {
  return {
    listedKg: 0,
    soldKg: 0,
    recoveredKg: 0,
    spoiledKg: 0,
    donatedKg: 0,
    disposedKg: 0,
    purchasedWithoutSoldOutcomeKg: 0,
    noOutcomeKg: 0,
    unaccountedKg: 0,
  };
}

function grams(quantity: number): number {
  return Math.round(quantity * 1000);
}

function kg(totalGrams: number): number {
  return totalGrams / 1000;
}

function trimKg(quantity: number): string {
  return `${quantity.toFixed(3).replace(/\.?0+$/, "")} kg`;
}
