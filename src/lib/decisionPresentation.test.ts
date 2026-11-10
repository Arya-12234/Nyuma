import { describe, expect, it } from "vitest";
import type { DecisionMetrics } from "../types/decision";
import { buildAllocationSegments, decisionHeadline, segmentShare } from "./decisionPresentation";

function metrics(overrides: Partial<DecisionMetrics> = {}): DecisionMetrics {
  return {
    availableQuantityKg: 800,
    eligibleDemandKg: 700,
    potentiallyMatchedKg: 700,
    unallocatedKg: 100,
    demandCoveragePercent: 87.5,
    indicativeGrossSalesKsh: 28000,
    priceComparison: {
      askingPriceKsh: 40,
      lowestIndicativeKsh: 38,
      highestIndicativeKsh: 42,
      weightedAverageIndicativeKsh: 39.71,
      indicativeAllocationValueKsh: 27800,
      differenceTotalKsh: -200,
      differencePerKgKsh: -0.29,
    },
    ...overrides,
  };
}

describe("decisionHeadline", () => {
  it("states the matched quantity and the surplus that remains", () => {
    expect(decisionHeadline("surplus", metrics())).toBe(
      "700 kg could be matched to the selected buyers. 100 kg remains unallocated.",
    );
  });

  it("says when the available quantity is fully covered", () => {
    expect(
      decisionHeadline(
        "surplus",
        metrics({ availableQuantityKg: 700, potentiallyMatchedKg: 700, unallocatedKg: 0, demandCoveragePercent: 100 }),
      ),
    ).toBe("700 kg could be matched to the selected buyers. Nothing in this scenario would remain unallocated.");
  });

  it("refuses a purchase larger than eligible demand", () => {
    expect(decisionHeadline("purchase", metrics())).toBe(
      "Do not purchase more than 700 kg. 100 kg of the 800 kg under consideration has no buyer.",
    );
    expect(decisionHeadline("purchase", metrics())).not.toMatch(/additional/i);
  });

  it("describes an empty buyer set without inventing a match", () => {
    expect(
      decisionHeadline(
        "surplus",
        metrics({
          eligibleDemandKg: 0,
          potentiallyMatchedKg: 0,
          unallocatedKg: 800,
          demandCoveragePercent: 0,
          indicativeGrossSalesKsh: 0,
        }),
      ),
    ).toBe("No eligible buyer can take this produce in the current scenario.");
  });

  it("asks for a quantity when the entered amount is zero", () => {
    expect(
      decisionHeadline(
        "surplus",
        metrics({
          availableQuantityKg: 0,
          potentiallyMatchedKg: 0,
          unallocatedKg: 0,
          demandCoveragePercent: null,
          indicativeGrossSalesKsh: 0,
        }),
      ),
    ).toMatch(/above zero/);
  });
});

describe("buildAllocationSegments", () => {
  it("keeps filled buyers in order and adds the unallocated remainder", () => {
    const segments = buildAllocationSegments(
      [
        { buyerId: "green", buyerName: "Green Basket Wholesale", allocatedKg: 150 },
        { buyerId: "nairobi", buyerName: "Nairobi Fresh Produce", allocatedKg: 300 },
        { buyerId: "city", buyerName: "City Market Traders", allocatedKg: 250 },
      ],
      100,
    );
    expect(segments.map((segment) => [segment.label, segment.kilograms, segment.kind])).toEqual([
      ["Green Basket Wholesale", 150, "allocated"],
      ["Nairobi Fresh Produce", 300, "allocated"],
      ["City Market Traders", 250, "allocated"],
      ["Unallocated", 100, "unallocated"],
    ]);
    expect(segmentShare(100, 800)).toBe(12.5);
  });

  it("omits buyers who received nothing and omits a zero remainder", () => {
    const segments = buildAllocationSegments(
      [
        { buyerId: "a", buyerName: "A", allocatedKg: 80 },
        { buyerId: "b", buyerName: "B", allocatedKg: 0 },
      ],
      0,
    );
    expect(segments).toEqual([{ id: "a", label: "A", kilograms: 80, kind: "allocated", shade: 0 }]);
  });
});
