import { describe, expect, it } from "vitest";
import { COORDINATION_STORAGE_KEY } from "../domain/coordinationDocument";
import {
  createLocalCoordinationRepository,
  createSequentialIdGenerator,
  createSteppedClock,
  type CoordinationRepository,
} from "../domain/coordinationRepository";
import type { CoordinationKeyValueStore } from "../domain/coordinationDocument";
import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../domain/records";
import { signIn } from "./auth";
import { createListingRecord } from "./coordinationWorkflow";
import { exposureReport, listingExposure, type ExposureAudience } from "./surplus";

const stamp = "2026-11-03T12:00:00.000Z";

function listing(patch: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "sample-farmer",
    commodity: "Watermelon",
    quantity: 120,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Nairobi",
    availabilityWindow: "Today",
    askingPriceKshPerKg: 40,
    status: "open",
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

function demand(patch: Partial<BuyerDemand> = {}): BuyerDemand {
  return {
    id: "demand-1",
    buyerId: "sample-buyer",
    commodity: "Watermelon",
    requestedQuantity: 300,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

function commitment(patch: Partial<Commitment> = {}): Commitment {
  return {
    id: "commitment-1",
    listingId: "listing-1",
    buyerDemandId: "demand-1",
    agreedQuantity: 80,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-04",
    status: "confirmed",
    createdAt: stamp,
    updatedAt: stamp,
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
    quantity: 40,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes: "",
    recordedAt: stamp,
    ...patch,
  };
}

function purchase(patch: Partial<Purchase> = {}): Purchase {
  return {
    id: "purchase-1",
    commitmentId: "commitment-1",
    listingId: "listing-1",
    actualQuantity: 80,
    quantityUnit: "kg",
    actualPriceKshPerKg: 40,
    purchaseDate: "2026-11-04",
    recordedAt: stamp,
    ...patch,
  };
}

function report(
  audience: ExposureAudience,
  accountId: string,
  records: {
    listings?: Listing[];
    demands?: BuyerDemand[];
    commitments?: Commitment[];
    purchases?: Purchase[];
    outcomes?: Outcome[];
  },
) {
  return exposureReport({
    listings: records.listings ?? [],
    demands: records.demands ?? [],
    commitments: records.commitments ?? [],
    purchases: records.purchases ?? [],
    outcomes: records.outcomes ?? [],
    audience,
    accountId,
  });
}

describe("surplus exposure", () => {
  it("treats an available listing with no agreement as fully exposed", () => {
    const exposure = listingExposure(listing(), [], [], [demand()]);
    expect(exposure).toMatchObject({
      listedKg: 120,
      heldKg: 0,
      purchasedKg: 0,
      notYetPurchasedKg: 120,
      uncommittedKg: 120,
      exposedKg: 120,
      compatibleOpenDemand: true,
    });
    const alerts = report("trader", "sample-trader", {
      listings: [listing({ ownerId: "sample-trader" })],
      demands: [demand()],
    }).alerts;
    expect(alerts.map((alert) => alert.id)).toEqual(["available-uncommitted:listing-1"]);
    expect(alerts[0]?.detected).not.toContain("no open buyer requirement");
  });

  it("keeps the uncommitted remainder when an agreement covers only part of a listing", () => {
    const exposure = listingExposure(listing({ quantity: 200 }), [commitment({ agreedQuantity: 80 })], [], [demand()]);
    expect(exposure).toMatchObject({ heldKg: 80, confirmedKg: 80, uncommittedKg: 120, purchasedKg: 0, exposedKg: 200 });
    const alerts = report("farmer", "sample-farmer", {
      listings: [listing({ quantity: 200 })],
      demands: [demand()],
      commitments: [commitment({ agreedQuantity: 80 })],
    }).alerts;
    expect(alerts.map((alert) => alert.id)).toEqual([
      "commitment-unpurchased:commitment-1",
      "partial-commitment:listing-1",
    ]);
    expect(alerts.find((alert) => alert.id.startsWith("partial"))?.quantityKg).toBe(120);
  });

  it("does not call a fully reserved listing uncommitted while the purchase is still missing", () => {
    const exposure = listingExposure(listing({ quantity: 100 }), [commitment({ agreedQuantity: 100 })], [], [demand()]);
    expect(exposure.uncommittedKg).toBe(0);
    expect(exposure.exposedKg).toBe(100);
    const ids = report("farmer", "sample-farmer", {
      listings: [listing({ quantity: 100 })],
      demands: [demand()],
      commitments: [commitment({ agreedQuantity: 100 })],
    }).alerts.map((alert) => alert.id);
    expect(ids).toEqual(["commitment-unpurchased:commitment-1"]);
  });

  it("counts a partial purchase once and leaves the agreement open", () => {
    const bought = purchase({ actualQuantity: 40 });
    const exposure = listingExposure(listing({ quantity: 100 }), [commitment({ agreedQuantity: 100 })], [bought], []);
    expect(exposure).toMatchObject({ heldKg: 100, purchasedKg: 40, notYetPurchasedKg: 60, exposedKg: 60, uncommittedKg: 0 });
    const alert = report("farmer", "sample-farmer", {
      listings: [listing({ quantity: 100 })],
      commitments: [commitment({ agreedQuantity: 100 })],
      purchases: [bought],
    }).alerts[0];
    expect(alert).toMatchObject({ id: "commitment-unpurchased:commitment-1", tone: "info", quantityKg: 60 });
  });

  it("shows no exposure warning when the confirmed agreement is fully purchased", () => {
    const bought = purchase({ actualQuantity: 100 });
    const exposure = listingExposure(listing({ quantity: 100 }), [commitment({ agreedQuantity: 100 })], [bought], [demand()]);
    expect(exposure).toMatchObject({ purchasedKg: 100, exposedKg: 0, heldKg: 100 });
    expect(
      report("farmer", "sample-farmer", {
        listings: [listing({ quantity: 100 })],
        demands: [demand()],
        commitments: [commitment({ agreedQuantity: 100 })],
        purchases: [bought],
      }).alerts,
    ).toEqual([]);
  });

  it("releases a cancelled agreement and does not reserve its quantity", () => {
    const exposure = listingExposure(
      listing({ quantity: 100 }),
      [commitment({ status: "cancelled", agreedQuantity: 100 })],
      [],
      [],
    );
    expect(exposure).toMatchObject({ heldKg: 0, uncommittedKg: 100, exposedKg: 100 });
    expect(report("farmer", "sample-farmer", {
      listings: [listing({ quantity: 100 })],
      commitments: [commitment({ status: "cancelled", agreedQuantity: 100 })],
    }).alerts[0]?.id).toBe("available-uncommitted:listing-1");
  });

  it("sums several agreements without counting a purchase twice", () => {
    const commitments = [
      commitment({ id: "commitment-1", agreedQuantity: 100 }),
      commitment({ id: "commitment-2", agreedQuantity: 50 }),
      commitment({ id: "commitment-3", agreedQuantity: 80, status: "cancelled" }),
    ];
    const purchases = [purchase({ actualQuantity: 40 }), purchase({ id: "purchase-2", actualQuantity: 10 })];
    const exposure = listingExposure(listing({ quantity: 200 }), commitments, purchases, [demand()]);
    expect(exposure).toMatchObject({
      heldKg: 150,
      confirmedKg: 150,
      purchasedKg: 50,
      uncommittedKg: 50,
      exposedKg: 150,
    });
    expect(exposure.exposedKg).toBe(exposure.notYetPurchasedKg);
    const fulfilled = listingExposure(
      listing({ quantity: 100 }),
      [commitment({ agreedQuantity: 100, status: "fulfilled" })],
      [purchase({ actualQuantity: 60 })],
      [],
    );
    expect(fulfilled).toMatchObject({ heldKg: 60, purchasedKg: 60, uncommittedKg: 40, exposedKg: 40 });
  });

  it("removes recorded outcomes from exposure without subtracting a linked purchase twice", () => {
    const bought = purchase({ actualQuantity: 80 });
    const linked = outcome({ category: "sold", quantity: 80, purchaseId: "purchase-1", commitmentId: "commitment-1" });
    const spoiled = outcome({ id: "outcome-2", category: "spoiled", quantity: 20, purchaseId: null });
    const exposure = listingExposure(
      listing({ quantity: 200 }),
      [commitment({ agreedQuantity: 80 })],
      [bought],
      [],
      [linked, spoiled],
    );
    expect(exposure).toMatchObject({
      purchasedKg: 80,
      notYetPurchasedKg: 120,
      settledOutsidePurchaseKg: 20,
      exposedKg: 100,
    });
    expect(exposure.exposedKg).toBe(exposure.notYetPurchasedKg - exposure.settledOutsidePurchaseKg);
    const covered = listingExposure(listing({ quantity: 120 }), [], [], [], [outcome({ quantity: 120 })]);
    expect(covered.exposedKg).toBe(0);
    expect(report("farmer", "sample-farmer", {
      listings: [listing({ quantity: 120 })],
      outcomes: [outcome({ quantity: 120 })],
    }).alerts).toEqual([]);
  });

  it("keeps expected harvest out of the exposed surplus", () => {
    const harvest = listing({ quantityKind: "expected", quantity: 750, availabilityWindow: "3 hours" });
    const exposure = listingExposure(
      harvest,
      [commitment({ agreedQuantity: 200 })],
      [purchase({ actualQuantity: 120 })],
      [demand()],
    );
    expect(exposure.exposedKg).toBeNull();
    expect(exposure).toMatchObject({ listedKg: 750, heldKg: 200, purchasedKg: 120, notYetPurchasedKg: 630 });
    const view = report("farmer", "sample-farmer", {
      listings: [harvest],
      demands: [demand()],
      commitments: [commitment({ agreedQuantity: 200 })],
      purchases: [purchase({ actualQuantity: 120 })],
    });
    expect(view.upcoming).toHaveLength(1);
    expect(view.available).toHaveLength(0);
    expect(view.summary.exposedKg).toBe(0);
    expect(view.summary.upcomingKg).toBe(750);
    expect(view.alerts.map((alert) => alert.id)).toEqual([
      "commitment-unpurchased:commitment-1",
      "expected-harvest:listing-1",
    ]);
    expect(view.alerts[1]?.why).toContain("not ready for collection");
  });

  it("mentions a missing compatible requirement once", () => {
    const mango = listing({
      id: "listing-2",
      ownerId: "sample-trader",
      commodity: "Mango",
      quantity: 120,
      availabilityWindow: "Today",
    });
    const tomorrow = listing({ availabilityWindow: "3 hours" });
    const view = report("trader", "sample-trader", {
      listings: [mango],
      demands: [demand()],
    });
    expect(view.available[0]?.compatibleOpenDemand).toBe(false);
    expect(view.alerts).toHaveLength(1);
    expect(view.alerts[0]?.detected).toContain("no open buyer requirement");
    const windowMismatch = listingExposure(tomorrow, [], [], [demand({ collectionWindow: "Tomorrow" })]);
    expect(windowMismatch.compatibleOpenDemand).toBe(false);
  });

  it("shows a buyer only the remainder on that buyer's requirement", () => {
    const records = {
      listings: [listing()],
      demands: [demand(), demand({ id: "demand-2", buyerId: "sample-farmer", requestedQuantity: 90 })],
      commitments: [commitment({ agreedQuantity: 200 })],
    };
    const buyer = report("buyer", "sample-buyer", records);
    expect(buyer.demands).toEqual([{ demandId: "demand-1", requestedKg: 300, heldKg: 200, remainingKg: 100 }]);
    expect(buyer.available).toHaveLength(0);
    expect(buyer.alerts.map((alert) => alert.id)).toEqual([
      "commitment-unpurchased:commitment-1",
      "demand-remaining:demand-1",
    ]);
    const farmer = report("farmer", "sample-farmer", records);
    expect(farmer.demands).toHaveLength(0);
    expect(farmer.alerts.some((alert) => alert.id.startsWith("demand-remaining"))).toBe(false);
    const trader = report("trader", "sample-trader", records);
    expect(trader.available).toHaveLength(0);
    expect(trader.alerts).toHaveLength(0);
  });

  it("keeps the administrator view read-only in its alert text and includes every open record", () => {
    const view = report("administrator", "sample-administrator", {
      listings: [listing({ ownerId: "sample-trader", quantity: 120 }), listing({ id: "listing-9", status: "closed" })],
      demands: [demand({ requestedQuantity: 50 })],
    });
    expect(view.available).toHaveLength(1);
    expect(view.summary).toMatchObject({ availableUnconfirmedCount: 1, exposedKg: 120, purchasedKg: 0 });
    expect(view.demands[0]?.remainingKg).toBe(50);
    expect(view.alerts.every((alert) => alert.action.includes("cannot change"))).toBe(true);
    expect(view.alerts.some((alert) => alert.subjectId === "listing-9")).toBe(false);
    expect(view.alerts.map((alert) => alert.id)).toEqual(["available-uncommitted:listing-1", "demand-remaining:demand-1"]);
  });

  it("returns an empty review when the account has no open listings or requirements", () => {
    const view = report("farmer", "sample-farmer", { listings: [listing({ status: "draft" })] });
    expect(view.upcoming).toHaveLength(0);
    expect(view.available).toHaveLength(0);
    expect(view.alerts).toHaveLength(0);
  });

  it("reads the same exposure from saved records after a new repository opens the store", async () => {
    const store = memoryStore();
    const trader = signIn("winnie@nyuma.ke", "harvest40");
    if (!trader.ok) throw new Error("sample sign-in failed");
    const saved = await createListingRecord(
      localRepository(store),
      trader.user,
      {
        commodity: "Mango",
        quantity: "120",
        quantityKind: "available",
        location: "Nairobi",
        availabilityWindow: "Today",
        askingPrice: "",
      },
      "open",
    );
    if (!saved.ok) throw new Error(saved.message);
    const reloaded = await localRepository(store).listListings();
    if (!reloaded.ok) throw new Error(reloaded.message);
    const view = report("trader", trader.user.id, { listings: [...reloaded.value] });
    expect(reloaded.value.map((item) => item.id)).toEqual([saved.value.id]);
    expect(view.available[0]).toMatchObject({ listedKg: 120, exposedKg: 120, purchasedKg: 0 });
    expect(store.raw[COORDINATION_STORAGE_KEY]).toContain(saved.value.id);
  });
});

function localRepository(store: CoordinationKeyValueStore): CoordinationRepository {
  return createLocalCoordinationRepository(store, {
    clock: createSteppedClock(stamp),
    ids: createSequentialIdGenerator(),
  });
}

function memoryStore(): CoordinationKeyValueStore & { raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  return {
    raw,
    getItem: (key) => (key in raw ? raw[key] : null),
    setItem: (key, value) => {
      raw[key] = value;
    },
  };
}
