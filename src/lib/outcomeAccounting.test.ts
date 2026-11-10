import { describe, expect, it } from "vitest";
import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../domain/records";
import { listingOutcomeAccount, outcomeBlock, outcomeSummary, outcomesForBuyer, type OutcomeInput } from "./outcomeAccounting";
import { listingExposure } from "./surplus";

const stamp = "2026-11-03T12:00:00.000Z";

function listing(patch: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "sample-farmer",
    commodity: "Watermelon",
    quantity: 100,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

function purchase(patch: Partial<Purchase> = {}): Purchase {
  return {
    id: "purchase-1",
    commitmentId: "commitment-1",
    listingId: "listing-1",
    actualQuantity: 60,
    quantityUnit: "kg",
    actualPriceKshPerKg: 40,
    purchaseDate: "2026-11-04",
    recordedAt: stamp,
    ...patch,
  };
}

function outcome(patch: Partial<Outcome> = {}): Outcome {
  return {
    id: "outcome-1",
    listingId: "listing-1",
    commitmentId: null,
    purchaseId: null,
    category: "spoiled",
    quantity: 10,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes: "",
    recordedAt: stamp,
    ...patch,
  };
}

function draft(patch: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    listingId: "listing-1",
    category: "spoiled",
    quantity: 10,
    purchaseId: null,
    commitmentId: null,
    recordedDate: "2026-11-06",
    notes: "",
    ...patch,
  };
}

describe("outcome quantities", () => {
  it("keeps several outcomes inside the listing and reports what is still unaccounted", () => {
    const rows = [
      outcome({ category: "recovered", quantity: 20 }),
      outcome({ id: "outcome-2", category: "donated", quantity: 15, recordedDate: "2026-11-07" }),
      outcome({ id: "outcome-3", category: "disposed", quantity: 5, recordedDate: "2026-11-08" }),
    ];
    const account = listingOutcomeAccount(listing(), rows, []);
    expect(account).toMatchObject({
      listedKg: 100,
      recoveredKg: 20,
      donatedKg: 15,
      disposedKg: 5,
      soldKg: 0,
      spoiledKg: 0,
      noOutcomeKg: 60,
      unaccountedKg: 60,
    });
    expect(outcomeBlock(listing(), draft({ quantity: 70 }), rows, [])).toContain("60 kg");
    expect(outcomeBlock(listing(), draft({ quantity: 60, recordedDate: "2026-11-09" }), rows, [])).toBeNull();
  });

  it("does not count a purchase and a sold outcome for that purchase twice", () => {
    const bought = purchase();
    const linked = outcome({ category: "sold", quantity: 60, purchaseId: "purchase-1", commitmentId: "commitment-1" });
    const account = listingOutcomeAccount(listing(), [linked], [bought]);
    expect(account.soldKg).toBe(60);
    expect(account.purchasedWithoutSoldOutcomeKg).toBe(0);
    expect(account.unaccountedKg).toBe(40);
    expect(account.noOutcomeKg).toBe(40);
    expect(outcomeBlock(listing(), draft({ category: "sold", quantity: 60, purchaseId: "purchase-1", commitmentId: "commitment-1", notes: "" }), [linked], [bought])).toContain("already");
    expect(outcomeBlock(listing(), draft({ category: "spoiled", quantity: 40, recordedDate: "2026-11-09" }), [linked], [bought])).toBeNull();
    expect(outcomeBlock(listing(), draft({ category: "spoiled", quantity: 41, recordedDate: "2026-11-09" }), [linked], [bought])).toContain("unaccounted");
    const exposure = listingExposure(listing(), [], [bought], [], [linked]);
    expect(exposure.exposedKg).toBe(40);
    expect(exposure.purchasedKg).toBe(60);
  });

  it("refuses an external sale or another outcome that overlaps a purchase", () => {
    const bought = purchase({ actualQuantity: 70 });
    expect(outcomeBlock(listing(), draft({ category: "sold", quantity: 40 }), [], [bought])).toContain("30 kg");
    expect(outcomeBlock(listing(), draft({ category: "recovered", quantity: 31 }), [], [bought])).toContain("unaccounted");
    const partial = outcome({ category: "sold", quantity: 20, purchaseId: "purchase-1", commitmentId: "commitment-1" });
    const account = listingOutcomeAccount(listing(), [partial], [bought]);
    expect(account.soldKg).toBe(20);
    expect(account.purchasedWithoutSoldOutcomeKg).toBe(50);
    expect(account.unaccountedKg).toBe(30);
  });

  it("hides another buyer's outcomes and any outcome that is not their purchase", () => {
    const demands: BuyerDemand[] = [{
      id: "demand-1",
      buyerId: "sample-buyer",
      commodity: "Watermelon",
      requestedQuantity: 100,
      quantityUnit: "kg",
      preferredLocation: "Nairobi",
      collectionWindow: "Today",
      indicativePriceKshPerKg: 42,
      status: "open",
      createdAt: stamp,
      updatedAt: stamp,
    }, {
      id: "demand-2",
      buyerId: "sample-farmer",
      commodity: "Mango",
      requestedQuantity: 40,
      quantityUnit: "kg",
      preferredLocation: "Nairobi",
      collectionWindow: "Today",
      indicativePriceKshPerKg: null,
      status: "open",
      createdAt: stamp,
      updatedAt: stamp,
    }];
    const commitments: Commitment[] = [{
      id: "commitment-1",
      listingId: "listing-1",
      buyerDemandId: "demand-1",
      agreedQuantity: 60,
      quantityUnit: "kg",
      agreedPriceKshPerKg: 40,
      expectedFulfilmentDate: "2026-11-04",
      status: "confirmed",
      createdAt: stamp,
      updatedAt: stamp,
    }, {
      id: "commitment-2",
      listingId: "listing-2",
      buyerDemandId: "demand-2",
      agreedQuantity: 20,
      quantityUnit: "kg",
      agreedPriceKshPerKg: 30,
      expectedFulfilmentDate: "2026-11-04",
      status: "confirmed",
      createdAt: stamp,
      updatedAt: stamp,
    }];
    const purchases = [
      purchase(),
      purchase({ id: "purchase-2", commitmentId: "commitment-2", listingId: "listing-2", actualQuantity: 20 }),
    ];
    const outcomes = [
      outcome({ category: "sold", quantity: 60, purchaseId: "purchase-1", commitmentId: "commitment-1", notes: "Private note" }),
      outcome({ id: "outcome-2", category: "spoiled", quantity: 10, notes: "Do not show" }),
      outcome({ id: "outcome-3", category: "sold", quantity: 20, purchaseId: "purchase-2", commitmentId: "commitment-2", listingId: "listing-2" }),
    ];
    const visible = outcomesForBuyer("sample-buyer", outcomes, purchases, commitments, demands);
    expect(visible.map((item) => item.id)).toEqual(["outcome-1"]);
    const summary = outcomeSummary(
      [listing(), listing({ id: "listing-2", ownerId: "sample-trader", quantity: 20 })],
      outcomes,
      purchases,
    );
    expect(summary.listingsWithOutcomes).toBe(2);
    expect(summary.soldKg).toBe(80);
    expect(summary.spoiledKg).toBe(10);
    expect(summary.listedKg).toBe(120);
  });

  it("leaves expected harvest unaccounted quantity separate from ready-to-collect exposure", () => {
    const harvest = listing({ quantityKind: "expected", quantity: 750 });
    const spoiled = outcome({ quantity: 30 });
    const account = listingOutcomeAccount(harvest, [spoiled], []);
    expect(account.unaccountedKg).toBe(720);
    expect(account.spoiledKg).toBe(30);
    const exposure = listingExposure(harvest, [], [], [], [spoiled]);
    expect(exposure.exposedKg).toBeNull();
    expect(exposure.settledOutsidePurchaseKg).toBe(30);
  });
});
