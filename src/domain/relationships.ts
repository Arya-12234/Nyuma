import type { CoordinationDocumentV1 } from "./records";
import { failure, success, type DomainErrorCode, type DomainResult } from "./result";

export type InvariantSource = "store" | "change";

/**
 * Quantity still spoken for on a listing:
 * a proposed or confirmed commitment holds its agreed quantity;
 * a fulfilled commitment holds only the quantity actually purchased;
 * a cancelled commitment holds nothing.
 * Recording a purchase does not change the commitment status.
 */
export function checkDocumentInvariants(
  document: CoordinationDocumentV1,
  source: InvariantSource,
): DomainResult<void> {
  const seen = new Map<string, string>();
  const duplicate = takeIds(document, seen, source);
  if (duplicate) return duplicate;

  const listings = new Map(document.listings.map((listing) => [listing.id, listing]));
  const demands = new Map(document.buyerDemands.map((demand) => [demand.id, demand]));
  const commitments = new Map(document.commitments.map((commitment) => [commitment.id, commitment]));
  const purchases = new Map(document.purchases.map((purchase) => [purchase.id, purchase]));

  for (const commitment of document.commitments) {
    const listing = listings.get(commitment.listingId);
    if (!listing) {
      return problem(source, "relationship", `Commitment ${commitment.id} refers to listing ${commitment.listingId}, which is missing.`);
    }
    const demand = demands.get(commitment.buyerDemandId);
    if (!demand) {
      return problem(
        source,
        "relationship",
        `Commitment ${commitment.id} refers to buyer demand ${commitment.buyerDemandId}, which is missing.`,
      );
    }
    if (listing.commodity !== demand.commodity) {
      return problem(
        source,
        "relationship",
        `Listing ${listing.id} is for ${listing.commodity} and buyer demand ${demand.id} is for ${demand.commodity}.`,
      );
    }
    if (commitment.quantityUnit !== listing.quantityUnit || demand.quantityUnit !== listing.quantityUnit) {
      return problem(source, "relationship", `Commitment ${commitment.id} uses a different quantity unit from its listing or buyer demand.`);
    }
    if (milli(commitment.agreedQuantity) > milli(demand.requestedQuantity)) {
      return problem(
        source,
        "relationship",
        `Commitment ${commitment.id} agrees ${kgText(milli(commitment.agreedQuantity))}, which is more than buyer demand ${demand.id} requested (${kgText(milli(demand.requestedQuantity))}).`,
      );
    }
    if (commitment.status === "cancelled" && purchasedMilli(document, commitment.id) > 0) {
      return problem(source, "relationship", `Commitment ${commitment.id} is cancelled but has a recorded purchase.`);
    }
  }

  for (const purchase of document.purchases) {
    const commitment = commitments.get(purchase.commitmentId);
    if (!commitment) {
      return problem(
        source,
        "relationship",
        `Purchase ${purchase.id} refers to commitment ${purchase.commitmentId}, which is missing.`,
      );
    }
    if (!listings.has(purchase.listingId)) {
      return problem(source, "relationship", `Purchase ${purchase.id} refers to listing ${purchase.listingId}, which is missing.`);
    }
    if (purchase.listingId !== commitment.listingId) {
      return problem(
        source,
        "relationship",
        `Purchase ${purchase.id} records listing ${purchase.listingId}, but commitment ${commitment.id} is for listing ${commitment.listingId}.`,
      );
    }
    if (purchase.quantityUnit !== commitment.quantityUnit) {
      return problem(source, "relationship", `Purchase ${purchase.id} uses a different quantity unit from commitment ${commitment.id}.`);
    }
  }

  for (const commitment of document.commitments) {
    const purchased = purchasedMilli(document, commitment.id);
    if (purchased > milli(commitment.agreedQuantity)) {
      return problem(
        source,
        "relationship",
        `Purchases against commitment ${commitment.id} would total ${kgText(purchased)}, which is more than the agreed ${kgText(milli(commitment.agreedQuantity))}.`,
      );
    }
  }

  for (const listing of document.listings) {
    const held = heldMilli(document, listing.id);
    if (held > milli(listing.quantity)) {
      return problem(
        source,
        "relationship",
        `Promised and purchased quantity would be ${kgText(held)}, which is more than the listing quantity of ${kgText(milli(listing.quantity))}.`,
      );
    }
  }

  for (const outcome of document.outcomes) {
    const listing = listings.get(outcome.listingId);
    if (!listing) {
      return problem(source, "relationship", `Outcome ${outcome.id} refers to listing ${outcome.listingId}, which is missing.`);
    }
    if (outcome.quantityUnit !== listing.quantityUnit) {
      return problem(source, "relationship", `Outcome ${outcome.id} uses a different quantity unit from listing ${listing.id}.`);
    }
    if (outcome.commitmentId !== null) {
      const commitment = commitments.get(outcome.commitmentId);
      if (!commitment) {
        return problem(
          source,
          "relationship",
          `Outcome ${outcome.id} refers to commitment ${outcome.commitmentId}, which is missing.`,
        );
      }
      if (commitment.listingId !== outcome.listingId) {
        return problem(
          source,
          "relationship",
          `Commitment ${commitment.id} is not recorded against listing ${outcome.listingId}.`,
        );
      }
    }
    if (outcome.purchaseId !== null) {
      const purchase = purchases.get(outcome.purchaseId);
      if (!purchase) {
        return problem(source, "relationship", `Outcome ${outcome.id} refers to purchase ${outcome.purchaseId}, which is missing.`);
      }
      if (purchase.listingId !== outcome.listingId) {
        return problem(source, "relationship", `Purchase ${purchase.id} is not recorded against listing ${outcome.listingId}.`);
      }
      if (outcome.commitmentId !== null && purchase.commitmentId !== outcome.commitmentId) {
        return problem(source, "relationship", `Purchase ${purchase.id} is not part of commitment ${outcome.commitmentId}.`);
      }
      if (outcome.category !== "sold") {
        return problem(source, "relationship", `An outcome linked to a purchase must use the sold category.`);
      }
    }
  }

  for (const listing of document.listings) {
    const covered = document.outcomes
      .filter((outcome) => outcome.listingId === listing.id)
      .reduce((sum, outcome) => sum + milli(outcome.quantity), 0);
    if (covered > milli(listing.quantity)) {
      return problem(
        source,
        "relationship",
        `Outcomes on listing ${listing.id} would cover ${kgText(covered)}, which is more than the listing quantity of ${kgText(milli(listing.quantity))}.`,
      );
    }
  }

  for (const purchase of document.purchases) {
    const linked = document.outcomes
      .filter((outcome) => outcome.purchaseId === purchase.id)
      .reduce((sum, outcome) => sum + milli(outcome.quantity), 0);
    if (linked > milli(purchase.actualQuantity)) {
      return problem(
        source,
        "relationship",
        `Sold outcomes for purchase ${purchase.id} would total ${kgText(linked)}, which is more than the purchased ${kgText(milli(purchase.actualQuantity))}.`,
      );
    }
  }

  return success(undefined);
}

function takeIds(
  document: CoordinationDocumentV1,
  seen: Map<string, string>,
  source: InvariantSource,
): DomainResult<never> | null {
  const groups: Array<[string, Array<{ id: string }>]> = [
    ["listings", document.listings],
    ["buyerDemands", document.buyerDemands],
    ["commitments", document.commitments],
    ["purchases", document.purchases],
    ["outcomes", document.outcomes],
  ];
  for (const [collection, records] of groups) {
    for (const record of records) {
      const existing = seen.get(record.id);
      if (!existing) {
        seen.set(record.id, collection);
        continue;
      }
      if (existing === collection) {
        return problem(source, "conflict", `Two ${collection} records use the id ${record.id}.`);
      }
      return problem(source, "conflict", `The id ${record.id} is used by both ${existing} and ${collection}.`);
    }
  }
  return null;
}

function heldMilli(document: CoordinationDocumentV1, listingId: string): number {
  let held = 0;
  for (const commitment of document.commitments) {
    if (commitment.listingId !== listingId) continue;
    if (commitment.status === "proposed" || commitment.status === "confirmed") {
      held += milli(commitment.agreedQuantity);
    } else if (commitment.status === "fulfilled") {
      held += purchasedMilli(document, commitment.id);
    }
  }
  return held;
}

function purchasedMilli(document: CoordinationDocumentV1, commitmentId: string): number {
  return document.purchases
    .filter((purchase) => purchase.commitmentId === commitmentId)
    .reduce((sum, purchase) => sum + milli(purchase.actualQuantity), 0);
}

function milli(quantity: number): number {
  return Math.round(quantity * 1000);
}

function kgText(quantityMilli: number): string {
  const sign = quantityMilli < 0 ? "-" : "";
  const absolute = Math.abs(quantityMilli);
  const whole = Math.trunc(absolute / 1000);
  const fraction = absolute % 1000;
  if (fraction === 0) return `${sign}${whole} kg`;
  const digits = String(fraction).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}.${digits} kg`;
}

function problem(source: InvariantSource, code: DomainErrorCode, message: string): DomainResult<never> {
  const tail = source === "store" ? "The stored data was left unchanged." : "The change was not saved.";
  return failure(code, `${message} ${tail}`);
}
