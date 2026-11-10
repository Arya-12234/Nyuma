import { describe, expect, it } from "vitest";
import { SAMPLE_BUYERS } from "../data/scenarioData";
import { evaluateScenario } from "../lib/decisionEngine";
import type { Buyer, ProduceScenario } from "../types/decision";
import { matchListingToDemand } from "./matchListing";
import type { BuyerDemand, Listing } from "./records";

const STAMP = "2026-11-03T12:00:00.000Z";

function publishedScenario(): ProduceScenario {
  return {
    produce: "Watermelon",
    quantityKg: 800,
    askingPriceKsh: 40,
    location: "Kitui",
    timeRemaining: "3 hours",
    mode: "surplus",
  };
}

function openListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "owner-1",
    commodity: "Watermelon",
    quantity: 800,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function demand(overrides: Partial<BuyerDemand> = {}): BuyerDemand {
  return {
    id: "demand-1",
    buyerId: "buyer-1",
    commodity: "Watermelon",
    requestedQuantity: 100,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 40,
    status: "open",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function demandFromSample(buyer: Buyer, overrides: Partial<BuyerDemand> = {}): BuyerDemand {
  return demand({
    id: buyer.id,
    buyerId: buyer.id,
    commodity: buyer.produce,
    requestedQuantity: buyer.quantityKg,
    preferredLocation: "Nairobi",
    collectionWindow: buyer.collection,
    indicativePriceKshPerKg: buyer.indicativePriceKsh,
    status: "open",
    ...overrides,
  });
}

describe("matchListingToDemand", () => {
  it("reproduces the 800 kg watermelon scenario through the engine", () => {
    const listing = openListing();
    const demands = SAMPLE_BUYERS.map((buyer) => demandFromSample(buyer));
    const beforeListing = structuredClone(listing);
    const beforeDemands = structuredClone(demands);

    const result = matchListingToDemand(listing, demands);
    const published = evaluateScenario(publishedScenario(), SAMPLE_BUYERS, SAMPLE_BUYERS.map((buyer) => buyer.id));

    expect(listing).toEqual(beforeListing);
    expect(demands).toEqual(beforeDemands);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scenario).toEqual(publishedScenario());
    expect(result.value.decision.metrics).toEqual(published.metrics);
    expect(result.value.decision.recommendations).toEqual(published.recommendations);
    expect(result.value.decision.metrics.availableQuantityKg).toBe(800);
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(700);
    expect(result.value.decision.metrics.unallocatedKg).toBe(100);
    expect(result.value.decision.metrics.indicativeGrossSalesKsh).toBe(28000);
    expect(result.value.decision.allocations.map((allocation) => [allocation.buyerId, allocation.allocatedKg])).toEqual([
      ["green-basket-wholesale", 150],
      ["nairobi-fresh-produce", 300],
      ["city-market-traders", 250],
    ]);
    expect(result.value.decision).toEqual(
      evaluateScenario(result.value.scenario, result.value.buyers, result.value.selectedDemandIds),
    );
  });

  it("reports no match when no buyer demand is supplied", () => {
    const result = matchListingToDemand(openListing(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(0);
    expect(result.value.decision.metrics.unallocatedKg).toBe(800);
    expect(result.value.decision.metrics.eligibleDemandKg).toBe(0);
    expect(result.value.decision.recommendations.map((recommendation) => recommendation.id)).toContain("no-eligible-demand");
  });

  it("leaves the uncovered quantity unallocated when demand is smaller than the listing", () => {
    const result = matchListingToDemand(openListing(), [demand({ requestedQuantity: 100, indicativePriceKshPerKg: 40 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(100);
    expect(result.value.decision.metrics.unallocatedKg).toBe(700);
    expect(result.value.decision.metrics.indicativeGrossSalesKsh).toBe(4000);
  });

  it("stops at the listing quantity when demand is larger", () => {
    const result = matchListingToDemand(openListing(), [
      demand({ requestedQuantity: 1000, indicativePriceKshPerKg: 42, id: "demand-large" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(800);
    expect(result.value.decision.metrics.unallocatedKg).toBe(0);
    expect(result.value.decision.metrics.indicativeGrossSalesKsh).toBe(32000);
    expect(result.value.decision.allocations[0]).toMatchObject({ requestedKg: 1000, allocatedKg: 800 });
  });

  it("leaves a different commodity unmatched", () => {
    const result = matchListingToDemand(openListing(), [demand({ commodity: "Mango", requestedQuantity: 300 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision.allocations[0]).toMatchObject({ eligible: false, allocatedKg: 0, statusLabel: "Produce does not match" });
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(0);
    expect(result.value.decision.metrics.unallocatedKg).toBe(800);
  });

  it("leaves a collection window outside the listing window unmatched", () => {
    const tomorrow = matchListingToDemand(openListing(), [demand({ collectionWindow: "Tomorrow" })]);
    expect(tomorrow.ok).toBe(true);
    if (!tomorrow.ok) return;
    expect(tomorrow.value.decision.allocations[0]).toMatchObject({ eligible: false, statusLabel: "Outside selling window" });
    expect(tomorrow.value.decision.metrics.potentiallyMatchedKg).toBe(0);

    const tooLong = matchListingToDemand(openListing({ availabilityWindow: "2 hours" }), [
      demand({ collectionWindow: "4 hours", id: "demand-4h" }),
      demand({ collectionWindow: "Today", id: "demand-today", requestedQuantity: 50 }),
    ]);
    expect(tooLong.ok).toBe(true);
    if (!tooLong.ok) return;
    expect(tooLong.value.decision.allocations.find((allocation) => allocation.buyerId === "demand-4h")).toMatchObject({
      eligible: false,
    });
    expect(tooLong.value.decision.allocations.find((allocation) => allocation.buyerId === "demand-today")).toMatchObject({
      allocatedKg: 50,
      eligible: true,
    });
  });

  it("does not calculate a match for a closed, withdrawn, or draft listing", () => {
    for (const status of ["closed", "withdrawn", "draft"] as const) {
      const listing = openListing({ status });
      const before = structuredClone(listing);
      const result = matchListingToDemand(listing, [demand()]);
      expect(listing).toEqual(before);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("relationship");
        expect(result.message).toMatch(new RegExp(status));
      }
    }
  });

  it("does not allocate closed or withdrawn demand", () => {
    const result = matchListingToDemand(openListing(), [
      demand({
        id: "closed-high",
        buyerId: "buyer-closed",
        status: "closed",
        requestedQuantity: 150,
        indicativePriceKshPerKg: 42,
      }),
      demand({
        id: "open-low",
        buyerId: "buyer-open",
        status: "open",
        requestedQuantity: 250,
        indicativePriceKshPerKg: 38,
      }),
      demand({
        id: "withdrawn-mid",
        buyerId: "buyer-withdrawn",
        status: "withdrawn",
        requestedQuantity: 300,
        indicativePriceKshPerKg: 40,
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedDemandIds).toEqual(["open-low"]);
    expect(result.value.decision.metrics.potentiallyMatchedKg).toBe(250);
    expect(result.value.decision.allocations.find((allocation) => allocation.buyerId === "closed-high")).toMatchObject({
      allocatedKg: 0,
      eligible: false,
      statusLabel: "Not included",
    });
    expect(result.value.decision.allocations.find((allocation) => allocation.buyerId === "withdrawn-mid")).toMatchObject({
      allocatedKg: 0,
      eligible: false,
      statusLabel: "Not included",
    });
  });

  it("rejects a missing price, a damaged record, and duplicate demand ids", () => {
    const noAsking = matchListingToDemand(openListing({ askingPriceKshPerKg: null }), []);
    expect(noAsking.ok).toBe(false);
    if (!noAsking.ok) expect(noAsking.message).toMatch(/asking price/);

    const noIndicative = matchListingToDemand(openListing(), [demand({ indicativePriceKshPerKg: null })]);
    expect(noIndicative.ok).toBe(false);
    if (!noIndicative.ok) expect(noIndicative.message).toMatch(/indicative price/);

    const missingList = matchListingToDemand(openListing(), null as unknown as BuyerDemand[]);
    expect(missingList.ok).toBe(false);
    if (!missingList.ok) expect(missingList.message).toMatch(/must be a list/);

    const damaged = matchListingToDemand({ ...openListing(), quantity: "800" } as unknown as Listing, []);
    expect(damaged.ok).toBe(false);
    if (!damaged.ok) expect(damaged.message).toMatch(/quantity/);

    const duplicate = matchListingToDemand(openListing(), [demand({ id: "same" }), demand({ id: "same", buyerId: "buyer-2" })]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("conflict");
  });
});
