import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../domain/records";
import { signIn } from "./auth";
import { MATCH_LABEL } from "./traderRecords";
import { matchTraderListings, summarizeTrader, type TraderRecordSet } from "./traderRecords";
import {
  TraderAnalyticsView,
  TraderDemandView,
  TraderMatchesView,
  TraderOverviewView,
} from "../components/workspaces/TraderCoordination";

const stamp = "2026-11-03T12:00:00.000Z";

function listing(patch: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "sample-trader",
    commodity: "Watermelon",
    quantity: 800,
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
    agreedQuantity: 200,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-04",
    status: "confirmed",
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
    actualQuantity: 80,
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
    quantity: 20,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes: "",
    recordedAt: stamp,
    ...patch,
  };
}

function records(patch: Partial<TraderRecordSet> = {}): TraderRecordSet {
  return {
    listings: patch.listings ?? [],
    demands: patch.demands ?? [],
    commitments: patch.commitments ?? [],
    purchases: patch.purchases ?? [],
    outcomes: patch.outcomes ?? [],
  };
}

function trader() {
  const result = signIn("winnie@nyuma.ke", "harvest40");
  if (!result.ok) throw new Error("trader sign-in failed");
  return result.user;
}

function html(node: ReactElement): string {
  return renderToStaticMarkup(node).replace(/&#x27;/g, "'");
}

describe("trader overview totals", () => {
  it("stays empty without fabricating the watermelon scenario", () => {
    const summary = summarizeTrader("sample-trader", records());
    expect(summary).toMatchObject({
      openListingCount: 0,
      listedKg: null,
      availableNowKg: null,
      expectedHarvestKg: null,
      compatibleRequirementCount: 0,
      confirmedCount: 0,
      confirmedKg: null,
      cancelledCount: 0,
      purchaseCount: 0,
      purchasedKg: null,
      exposedKg: 0,
      upcomingKg: 0,
    });
    expect(summary.listedKg).not.toBe(800);
    expect(summary.exposedKg).not.toBe(100);
  });

  it("separates expected harvest from available produce and ignores another account", () => {
    const summary = summarizeTrader(
      "sample-trader",
      records({
        listings: [
          listing({ quantity: 120, quantityKind: "available" }),
          listing({ id: "listing-expected", quantity: 50, quantityKind: "expected" }),
          listing({ id: "listing-draft", quantity: 10, status: "draft" }),
          listing({ id: "farmer-listing", ownerId: "sample-farmer", quantity: 750, quantityKind: "expected" }),
        ],
      }),
    );
    expect(summary.openListingCount).toBe(2);
    expect(summary.availableNowKg).toBe(120);
    expect(summary.expectedHarvestKg).toBe(50);
    expect(summary.listedKg).toBe(170);
    expect(summary.draftCount).toBe(1);
    expect(summary.upcomingKg).toBe(50);
    expect(summary.exposedKg).toBe(120);
  });

  it("counts confirmed agreements and purchases, and leaves cancelled agreements out", () => {
    const summary = summarizeTrader(
      "sample-trader",
      records({
        listings: [listing({ quantity: 200 })],
        demands: [demand()],
        commitments: [
          commitment({ agreedQuantity: 80, status: "confirmed" }),
          commitment({ id: "commitment-cancelled", agreedQuantity: 30, status: "cancelled" }),
          commitment({ id: "commitment-proposed", agreedQuantity: 15, status: "proposed" }),
        ],
        purchases: [purchase({ actualQuantity: 40 }), purchase({ id: "purchase-2", actualQuantity: 10 })],
      }),
    );
    expect(summary.confirmedCount).toBe(1);
    expect(summary.confirmedKg).toBe(80);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.proposedCount).toBe(1);
    expect(summary.purchaseCount).toBe(2);
    expect(summary.purchasedKg).toBe(50);
    expect(summary.exposedKg).toBe(150);
    expect(summary.compatibleRequirementCount).toBe(1);
  });

  it("reduces exposed quantity with the existing surplus rule", () => {
    const summary = summarizeTrader(
      "sample-trader",
      records({
        listings: [listing({ quantity: 200 })],
        commitments: [commitment()],
        purchases: [purchase({ actualQuantity: 80 })],
        outcomes: [outcome({ quantity: 20 })],
      }),
    );
    expect(summary.exposedKg).toBe(100);
    expect(summary.purchasedKg).toBe(80);
  });
});

describe("trader matches from saved records", () => {
  it("suggests a partial allocation across several open requirements and leaves the rest unallocated", () => {
    const before = records({
      listings: [listing()],
      demands: [
        demand({ id: "demand-high", requestedQuantity: 300, indicativePriceKshPerKg: 42 }),
        demand({ id: "demand-low", requestedQuantity: 250, indicativePriceKshPerKg: 38 }),
      ],
    });
    const snapshot = structuredClone(before);
    const [view] = matchTraderListings("sample-trader", before.listings, before.demands);
    expect(before).toEqual(snapshot);
    expect(view.suggestions.map((item) => item.suggestedKg)).toEqual([300, 250]);
    expect(view.unallocatedKg).toBe(250);
    expect(view.suggestions.every((item) => item.label === MATCH_LABEL)).toBe(true);
    expect(view.planning).toBe(false);
    expect(JSON.stringify(view)).not.toContain("commitment");
  });

  it("does not suggest incompatible produce or an incompatible collection window", () => {
    const [view] = matchTraderListings("sample-trader", [listing()], [
      demand({ id: "demand-mango", commodity: "Mango" }),
      demand({ id: "demand-tomorrow", collectionWindow: "Tomorrow" }),
    ]);
    expect(view.suggestions).toEqual([]);
    expect(view.unallocatedKg).toBe(800);
    expect(view.incompatible.map((item) => item.demandId).sort()).toEqual(["demand-mango", "demand-tomorrow"]);
    expect(view.incompatible.some((item) => item.why.includes("Mango"))).toBe(true);
    expect(view.incompatible.some((item) => item.why.includes("Tomorrow"))).toBe(true);
  });

  it("does not match closed or withdrawn listings or requirements", () => {
    for (const status of ["closed", "withdrawn", "draft"] as const) {
      const [view] = matchTraderListings("sample-trader", [listing({ status })], [demand()]);
      expect(view.suggestions).toEqual([]);
      expect(view.explanation).toContain(status);
      expect(view.unallocatedKg).toBeNull();
    }
    const [open] = matchTraderListings("sample-trader", [listing()], [
      demand({ status: "closed" }),
      demand({ id: "demand-withdrawn", status: "withdrawn" }),
    ]);
    expect(open.suggestions).toEqual([]);
    expect(open.incompatible).toEqual([]);
    expect(open.unallocatedKg).toBe(800);
  });

  it("explains an invalid requirement instead of inventing a match", () => {
    const [view] = matchTraderListings("sample-trader", [listing()], [demand({ indicativePriceKshPerKg: null })]);
    expect(view.suggestions).toEqual([]);
    expect(view.explanation).toMatch(/indicative price/i);
  });

  it("labels an expected harvest as planning and not ready to collect", () => {
    const [view] = matchTraderListings(
      "sample-trader",
      [listing({ quantityKind: "expected", quantity: 750 })],
      [demand({ requestedQuantity: 200 })],
    );
    expect(view.planning).toBe(true);
    expect(view.explanation).toMatch(/not ready for collection/i);
    expect(view.suggestions).toHaveLength(1);
    expect(view.suggestions[0].label).toBe(MATCH_LABEL);
    expect(view.suggestions[0].planning).toBe(true);
    expect(view.suggestions[0].why).toMatch(/not produce ready to collect/i);
    expect(view.suggestions[0].suggestedKg).toBe(200);
  });

  it("compares only the signed-in trader's listings", () => {
    const views = matchTraderListings("sample-trader", [
      listing({ id: "mine" }),
      listing({ id: "theirs", ownerId: "sample-farmer" }),
    ], [demand()]);
    expect(views.map((view) => view.listingId)).toEqual(["mine"]);
  });
});

describe("trader record screens", () => {
  const user = trader();

  it("shows an empty overview with next actions and no sample figures", () => {
    const markup = html(
      <TraderOverviewView
        user={user}
        data={{ phase: "ready", listings: [], demands: [], commitments: [], purchases: [], outcomes: [] }}
      />,
    );
    expect(markup).toContain("No saved trade records yet.");
    expect(markup).toContain("Add produce");
    expect(markup).toContain("Available now");
    expect(markup).toContain("Expected harvest");
    expect(markup).toContain("Still exposed");
    expect(markup).toContain("not a sale");
    expect(markup).toContain("not a confirmed order");
    expect(markup).not.toContain("28,000");
    expect(markup).not.toContain("700 kg");
    expect(markup).not.toContain("Nairobi Fresh Produce");
  });

  it("shows saved supply, a confirmed agreement, a cancelled agreement, and a purchase", () => {
    const markup = html(
      <TraderOverviewView
        user={user}
        data={{
          phase: "ready",
          listings: [
            listing({ quantity: 120 }),
            listing({ id: "listing-expected", quantity: 50, quantityKind: "expected" }),
          ],
          demands: [demand()],
          commitments: [
            commitment({ listingId: "listing-1", agreedQuantity: 40, status: "confirmed" }),
            commitment({ id: "commitment-cancelled", listingId: "listing-1", agreedQuantity: 25, status: "cancelled" }),
          ],
          purchases: [purchase({ actualQuantity: 30 })],
          outcomes: [],
        }}
      />,
    );
    expect(markup).toContain("120 kg");
    expect(markup).toContain("50 kg");
    expect(markup).toContain("40 kg");
    expect(markup).toContain("30 kg");
    expect(markup).toContain("Cancelled");
    expect(markup).not.toContain("25 kg");
    expect(markup).not.toContain("750");
    expect(markup).not.toContain("28,000");
  });

  it("lists a saved requirement and not the practice buyers", () => {
    const markup = html(
      <TraderDemandView
        data={{
          phase: "ready",
          listings: [],
          demands: [demand(), demand({ id: "demand-closed", status: "closed" })],
          commitments: [],
          purchases: [],
          outcomes: [],
        }}
      />,
    );
    expect(markup).toContain("Watermelon");
    expect(markup).toContain("not a confirmed order");
    expect(markup).toContain("Sample Buyer, sample account");
    expect(markup).toContain("Not open");
    expect(markup).not.toContain("Nairobi Fresh Produce");
  });

  it("shows a potential match without a way to save an agreement from the suggestion", () => {
    const markup = html(
      <TraderMatchesView
        user={user}
        data={{
          phase: "ready",
          listings: [listing({ quantity: 100 })],
          demands: [demand({ requestedQuantity: 300 })],
          commitments: [],
          purchases: [],
          outcomes: [],
        }}
      />,
    );
    expect(markup).toContain(MATCH_LABEL);
    expect(markup).toContain("100 kg");
    expect(markup).toContain("300 kg");
    expect(markup).toContain("not a guaranteed price");
    expect(markup).toContain("This page does not save one.");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("28,000");
  });

  it("explains unaccounted quantity on analytics", () => {
    const markup = html(
      <TraderAnalyticsView
        user={user}
        data={{
          phase: "ready",
          listings: [listing({ quantity: 100 })],
          demands: [],
          commitments: [],
          purchases: [],
          outcomes: [],
        }}
      />,
    );
    expect(markup).toContain("Unaccounted");
    expect(markup).toContain("does not mean spoiled");
    expect(markup).toContain("100 kg");
    expect(markup).not.toContain("28,000");
  });
});
