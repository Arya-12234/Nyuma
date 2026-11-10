import { describe, expect, it } from "vitest";
import { SAMPLE_BUYERS } from "../data/scenarioData";
import type { Buyer, ProduceScenario } from "../types/decision";
import { evaluateScenario, isTimeCompatible } from "./decisionEngine";

const allIds = SAMPLE_BUYERS.map((buyer) => buyer.id);

function scenario(overrides: Partial<ProduceScenario> = {}): ProduceScenario {
  return {
    produce: "Watermelon",
    quantityKg: 800,
    askingPriceKsh: 40,
    location: "Kitui",
    timeRemaining: "3 hours",
    mode: "surplus",
    ...overrides,
  };
}

function ids(buyers: readonly Buyer[]): string[] {
  return buyers.map((buyer) => buyer.id);
}

describe("isTimeCompatible", () => {
  it("treats a Today buyer as available inside every prototype selling window", () => {
    expect(isTimeCompatible("2 hours", "Today")).toBe(true);
    expect(isTimeCompatible("3 hours", "Today")).toBe(true);
    expect(isTimeCompatible("Today", "Today")).toBe(true);
    expect(isTimeCompatible("Tomorrow", "Today")).toBe(true);
  });

  it("keeps a Tomorrow buyer out of same-day windows", () => {
    expect(isTimeCompatible("2 hours", "Tomorrow")).toBe(false);
    expect(isTimeCompatible("Today", "Tomorrow")).toBe(false);
    expect(isTimeCompatible("Tomorrow", "Tomorrow")).toBe(true);
  });

  it("accepts an hour-specific collection only when the seller can wait that long", () => {
    expect(isTimeCompatible("2 hours", "4 hours")).toBe(false);
    expect(isTimeCompatible("4 hours", "2 hours")).toBe(true);
    expect(isTimeCompatible("Today", "4 hours")).toBe(true);
  });
});

describe("sample watermelon allocation", () => {
  it("matches the published 800 kg example", () => {
    const result = evaluateScenario(scenario(), SAMPLE_BUYERS, allIds);

    expect(result.allocations.map((allocation) => [allocation.buyerName, allocation.allocatedKg])).toEqual([
      ["Green Basket Wholesale", 150],
      ["Nairobi Fresh Produce", 300],
      ["City Market Traders", 250],
    ]);
    expect(result.metrics.availableQuantityKg).toBe(800);
    expect(result.metrics.eligibleDemandKg).toBe(700);
    expect(result.metrics.potentiallyMatchedKg).toBe(700);
    expect(result.metrics.unallocatedKg).toBe(100);
    expect(result.metrics.demandCoveragePercent).toBeCloseTo(87.5);
    expect(result.metrics.indicativeGrossSalesKsh).toBe(28000);
    expect(result.metrics.priceComparison.lowestIndicativeKsh).toBe(38);
    expect(result.metrics.priceComparison.highestIndicativeKsh).toBe(42);
    expect(result.metrics.priceComparison.indicativeAllocationValueKsh).toBe(27800);
    expect(result.metrics.priceComparison.differenceTotalKsh).toBe(-200);
    expect(result.metrics.priceComparison.weightedAverageIndicativeKsh).toBeCloseTo(27800 / 700);
  });

  it("does not change the allocation when location changes", () => {
    const kitui = evaluateScenario(scenario({ location: "Kitui" }), SAMPLE_BUYERS, allIds);
    const nairobi = evaluateScenario(scenario({ location: "Nairobi" }), SAMPLE_BUYERS, allIds);
    expect(nairobi.metrics).toEqual(kitui.metrics);
    expect(nairobi.allocations.map((allocation) => allocation.allocatedKg)).toEqual(
      kitui.allocations.map((allocation) => allocation.allocatedKg),
    );
  });

  it("is deterministic when the buyer list is reversed", () => {
    const forward = evaluateScenario(scenario(), SAMPLE_BUYERS, allIds);
    const reversed = evaluateScenario(scenario(), [...SAMPLE_BUYERS].reverse(), allIds);
    expect(reversed.allocations).toEqual(forward.allocations);
    expect(reversed.recommendations).toEqual(forward.recommendations);
  });
});

describe("selection, produce, and partial fills", () => {
  it("drops a buyer who is not included and reallocates the rest", () => {
    const result = evaluateScenario(
      scenario(),
      SAMPLE_BUYERS,
      allIds.filter((id) => id !== "green-basket-wholesale"),
    );

    expect(result.metrics.eligibleDemandKg).toBe(550);
    expect(result.metrics.potentiallyMatchedKg).toBe(550);
    expect(result.metrics.unallocatedKg).toBe(250);
    expect(result.metrics.indicativeGrossSalesKsh).toBe(22000);
    expect(result.allocations.find((allocation) => allocation.buyerId === "green-basket-wholesale")).toMatchObject({
      eligible: false,
      allocatedKg: 0,
      statusLabel: "Not included",
    });
  });

  it("fills only part of the highest price when supply runs out", () => {
    const result = evaluateScenario(scenario({ quantityKg: 100 }), SAMPLE_BUYERS, allIds);
    expect(result.allocations.map((allocation) => allocation.allocatedKg)).toEqual([100, 0, 0]);
    expect(result.metrics.potentiallyMatchedKg).toBe(100);
    expect(result.metrics.unallocatedKg).toBe(0);
    expect(result.metrics.demandCoveragePercent).toBe(100);
    expect(result.metrics.indicativeGrossSalesKsh).toBe(4000);
    expect(result.metrics.priceComparison.differenceTotalKsh).toBe(200);
    expect(result.allocations[0].allocationNote).toMatch(/Part of this request/);
    expect(result.allocations[1].allocationNote).toMatch(/higher indicative prices/);
  });

  it("excludes every sample buyer when the produce is not watermelon", () => {
    const result = evaluateScenario(scenario({ produce: "Mango" }), SAMPLE_BUYERS, allIds);
    expect(result.allocations.every((allocation) => allocation.eligible === false)).toBe(true);
    expect(result.metrics.eligibleDemandKg).toBe(0);
    expect(result.metrics.potentiallyMatchedKg).toBe(0);
    expect(result.metrics.unallocatedKg).toBe(800);
    expect(result.metrics.demandCoveragePercent).toBe(0);
    expect(result.metrics.priceComparison.lowestIndicativeKsh).toBeNull();
  });

  it("excludes a tomorrow collection from a same-day window and includes it tomorrow", () => {
    const buyers: Buyer[] = [
      ...SAMPLE_BUYERS,
      {
        id: "evening-desk",
        name: "Evening Desk",
        location: "Nairobi",
        produce: "Watermelon",
        quantityKg: 200,
        indicativePriceKsh: 36,
        collection: "Tomorrow",
      },
    ];
    const today = evaluateScenario(scenario({ timeRemaining: "3 hours" }), buyers, ids(buyers));
    const tomorrow = evaluateScenario(scenario({ timeRemaining: "Tomorrow" }), buyers, ids(buyers));

    expect(today.allocations.find((allocation) => allocation.buyerId === "evening-desk")).toMatchObject({
      eligible: false,
      statusLabel: "Outside selling window",
      allocatedKg: 0,
    });
    expect(today.metrics.eligibleDemandKg).toBe(700);
    expect(tomorrow.metrics.eligibleDemandKg).toBe(900);
    expect(tomorrow.metrics.potentiallyMatchedKg).toBe(800);
    expect(tomorrow.metrics.unallocatedKg).toBe(0);
  });

  it("rounds awkward kilogram splits back to the available quantity", () => {
    const buyers: Buyer[] = [
      {
        id: "a",
        name: "A",
        location: "Nairobi",
        produce: "Tomato",
        quantityKg: 0.1,
        indicativePriceKsh: 20,
        collection: "Today",
      },
      {
        id: "b",
        name: "B",
        location: "Nairobi",
        produce: "Tomato",
        quantityKg: 0.2,
        indicativePriceKsh: 10,
        collection: "Today",
      },
    ];
    const result = evaluateScenario(
      scenario({ produce: "Tomato", quantityKg: 0.3, askingPriceKsh: 15 }),
      buyers,
      ids(buyers),
    );
    expect(result.metrics.potentiallyMatchedKg).toBeCloseTo(0.3);
    expect(result.metrics.unallocatedKg).toBeCloseTo(0);
  });
});

describe("recommendations", () => {
  it("explains the default surplus shortfall, the short window, and the price spread", () => {
    const result = evaluateScenario(scenario(), SAMPLE_BUYERS, allIds);
    expect(result.recommendations.map((item) => item.id)).toEqual([
      "unmatched-surplus",
      "short-selling-window",
      "price-tradeoff",
    ]);
    expect(result.recommendations[0].message).toBe(
      "Some produce remains unmatched. Contact additional buyers or consider alternative markets.",
    );
    expect(result.recommendations[0].explanation).toContain("100 kg");
    expect(result.recommendations[1].message).toBe(
      "Prioritize buyers who can collect within your remaining selling window.",
    );
    expect(result.recommendations[1].explanation).toContain("3 hours");
    expect(result.recommendations[2].message).toBe(
      "Review the trade-off between buyer price and quantity requested before confirming allocations.",
    );
    expect(result.recommendations.every((item) => item.explanation.length > 20)).toBe(true);
  });

  it("confirms full cover without the short-window note when the window is the rest of today", () => {
    const result = evaluateScenario(scenario({ quantityKg: 700, timeRemaining: "Today" }), SAMPLE_BUYERS, allIds);
    expect(result.recommendations.map((item) => item.id)).toEqual(["demand-covers-available", "price-tradeoff"]);
    expect(result.recommendations[0].message).toBe(
      "Current buyer demand covers the available quantity. Confirm collection and payment terms.",
    );
  });

  it("states that no buyer fits when produce or selection removes them all", () => {
    const byProduce = evaluateScenario(scenario({ produce: "Banana", timeRemaining: "Today" }), SAMPLE_BUYERS, allIds);
    expect(byProduce.recommendations.map((item) => item.id)).toEqual(["no-eligible-demand"]);
    expect(byProduce.recommendations[0].message).toBe(
      "No eligible buyer demand is available in this scenario. Update your buyer information or seek additional leads.",
    );

    const noneSelected = evaluateScenario(scenario({ timeRemaining: "Today" }), SAMPLE_BUYERS, []);
    expect(noneSelected.recommendations[0].id).toBe("no-eligible-demand");
    expect(noneSelected.recommendations[0].explanation).toContain("None of the illustrative buyers are included");
  });

  it("does not recommend buying more than eligible demand", () => {
    const over = evaluateScenario(scenario({ mode: "purchase" }), SAMPLE_BUYERS, allIds);
    expect(over.recommendations.map((item) => item.id)).toEqual([
      "purchase-above-demand",
      "short-selling-window",
      "price-tradeoff",
    ]);
    expect(over.recommendations[0].message).toBe(
      "Do not purchase more produce than eligible buyer demand supports.",
    );
    expect(over.recommendations[0].explanation).toContain("700 kg");
    expect(over.recommendations.map((item) => item.message).join(" ")).not.toMatch(/additional/i);

    const covered = evaluateScenario(
      scenario({ mode: "purchase", quantityKg: 500, timeRemaining: "Today" }),
      SAMPLE_BUYERS,
      allIds,
    );
    expect(covered.recommendations[0].id).toBe("demand-covers-purchase");
    expect(covered.recommendations.map((item) => item.message).join(" ")).not.toMatch(/additional|buy more/i);
    expect(covered.metrics).toMatchObject({ potentiallyMatchedKg: 500, unallocatedKg: 0 });
    expect(covered.allocations.map((allocation) => allocation.allocatedKg)).toEqual(
      evaluateScenario(scenario({ quantityKg: 500, timeRemaining: "Today" }), SAMPLE_BUYERS, allIds).allocations.map(
        (allocation) => allocation.allocatedKg,
      ),
    );
  });

  it("omits the price trade-off when eligible prices are identical", () => {
    const buyers: Buyer[] = [
      {
        id: "one",
        name: "One",
        location: "Nairobi",
        produce: "Mango",
        quantityKg: 100,
        indicativePriceKsh: 50,
        collection: "Today",
      },
      {
        id: "two",
        name: "Two",
        location: "Nairobi",
        produce: "Mango",
        quantityKg: 80,
        indicativePriceKsh: 50,
        collection: "Today",
      },
    ];
    const result = evaluateScenario(
      scenario({ produce: "Mango", quantityKg: 50, timeRemaining: "Today", askingPriceKsh: 50 }),
      buyers,
      ids(buyers),
    );
    expect(result.recommendations.map((item) => item.id)).toEqual(["demand-covers-available"]);
    expect(result.allocations.map((allocation) => allocation.allocatedKg)).toEqual([50, 0]);
  });

  it("asks for a quantity when the entered amount is zero", () => {
    const result = evaluateScenario(scenario({ quantityKg: 0, timeRemaining: "Today" }), SAMPLE_BUYERS, allIds);
    expect(result.metrics.demandCoveragePercent).toBeNull();
    expect(result.metrics.potentiallyMatchedKg).toBe(0);
    expect(result.metrics.indicativeGrossSalesKsh).toBe(0);
    expect(result.recommendations[0].id).toBe("enter-quantity");
  });

  it("rejects quantities and prices the form should already have blocked", () => {
    expect(() => evaluateScenario(scenario({ quantityKg: -5 }), SAMPLE_BUYERS, allIds)).toThrow(/quantityKg/);
    expect(() => evaluateScenario(scenario({ askingPriceKsh: 0 }), SAMPLE_BUYERS, allIds)).toThrow(/askingPriceKsh/);
  });
});
