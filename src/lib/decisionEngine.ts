import { SHORT_SELLING_WINDOWS } from "../data/scenarioData";
import { describePriceGap, formatKg, formatKshPerKg } from "./format";
import type {
  Buyer,
  BuyerAllocation,
  BuyerMatch,
  DecisionMetrics,
  DecisionResult,
  PriceComparison,
  ProduceScenario,
  Recommendation,
  TimeWindow,
} from "../types/decision";

/** Latest hold time, in hours, used only to compare collection windows. */
const WINDOW_LIMIT_HOURS: Record<TimeWindow, number> = {
  "2 hours": 2,
  "3 hours": 3,
  "4 hours": 4,
  Today: 18,
  Tomorrow: 36,
};

export const ELIGIBILITY_RULES = [
  "The buyer is included in the scenario.",
  "The buyer requests the produce you selected.",
  "The buyer can collect before your selling window closes.",
] as const;

export const ALLOCATION_RULE =
  "Eligible buyers are filled from the highest indicative price to the lowest, up to each buyer's requested quantity. The asking price is not used to order the queue.";

/**
 * "Today" means the buyer can collect at any time today, including a short
 * same-day window. "Tomorrow" means they cannot collect until tomorrow.
 * An hour-specific collection fits only inside a window at least that long.
 */
export function isTimeCompatible(sellerWindow: TimeWindow, buyerCollection: TimeWindow): boolean {
  if (buyerCollection === "Today") return true;
  if (buyerCollection === "Tomorrow") return sellerWindow === "Tomorrow";
  return WINDOW_LIMIT_HOURS[buyerCollection] <= WINDOW_LIMIT_HOURS[sellerWindow];
}

export function describeBuyer(
  scenario: Pick<ProduceScenario, "produce" | "timeRemaining">,
  buyer: Buyer,
  selected: boolean,
): BuyerMatch {
  const produceMatch = buyer.produce === scenario.produce;
  const timeMatch = isTimeCompatible(scenario.timeRemaining, buyer.collection);
  const reasons: string[] = [];

  if (!selected) reasons.push("Not included in this scenario.");
  if (!produceMatch) reasons.push(`Requests ${buyer.produce}, not ${scenario.produce}.`);
  if (!timeMatch) {
    reasons.push(
      `Collection is ${buyer.collection}, which falls outside the ${scenario.timeRemaining} selling window.`,
    );
  }

  return {
    buyer,
    selected,
    produceMatch,
    timeMatch,
    eligible: selected && produceMatch && timeMatch,
    statusLabel: statusLabel(selected, produceMatch, timeMatch),
    reasons,
  };
}

export function evaluateScenario(
  scenario: ProduceScenario,
  buyers: readonly Buyer[],
  selectedIds: readonly string[],
): DecisionResult {
  assertScenario(scenario);
  const selected = new Set(selectedIds);
  const described = buyers.map((buyer) => describeBuyer(scenario, buyer, selected.has(buyer.id)));
  const allocations = allocate(scenario, described);
  const metrics = calculateMetrics(scenario, allocations);
  const recommendations = buildRecommendations(scenario, allocations, metrics);
  return { allocations, metrics, recommendations };
}

export function calculateMetrics(
  scenario: ProduceScenario,
  allocations: readonly BuyerAllocation[],
): DecisionMetrics {
  const eligible = allocations.filter((allocation) => allocation.eligible);
  const eligibleDemandKg = roundKg(eligible.reduce((sum, allocation) => sum + allocation.requestedKg, 0));
  const potentiallyMatchedKg = roundKg(eligible.reduce((sum, allocation) => sum + allocation.allocatedKg, 0));
  const unallocatedKg = roundKg(Math.max(0, scenario.quantityKg - potentiallyMatchedKg));
  const demandCoveragePercent =
    scenario.quantityKg > 0 ? (potentiallyMatchedKg / scenario.quantityKg) * 100 : null;
  const indicativeGrossSalesKsh = roundMoney(potentiallyMatchedKg * scenario.askingPriceKsh);

  return {
    availableQuantityKg: scenario.quantityKg,
    eligibleDemandKg,
    potentiallyMatchedKg,
    unallocatedKg,
    demandCoveragePercent,
    indicativeGrossSalesKsh,
    priceComparison: comparePrices(scenario.askingPriceKsh, eligible, potentiallyMatchedKg, indicativeGrossSalesKsh),
  };
}

function allocate(scenario: ProduceScenario, described: readonly BuyerMatch[]): BuyerAllocation[] {
  const eligible = described.filter((match) => match.eligible).slice().sort(byPriceThenName);
  let remaining = scenario.quantityKg;
  const allocatedById = new Map<string, number>();

  for (const match of eligible) {
    const take = Math.min(Math.max(0, remaining), match.buyer.quantityKg);
    const allocated = roundKg(take);
    allocatedById.set(match.buyer.id, allocated);
    remaining = roundKg(remaining - allocated);
  }

  const eligibleIds = new Set(eligible.map((match) => match.buyer.id));
  const ordered = [...eligible, ...described.filter((match) => !eligibleIds.has(match.buyer.id))];

  return ordered.map((match) => {
    const allocatedKg = allocatedById.get(match.buyer.id) ?? 0;
    return {
      buyerId: match.buyer.id,
      buyerName: match.buyer.name,
      location: match.buyer.location,
      produce: match.buyer.produce,
      collection: match.buyer.collection,
      requestedKg: match.buyer.quantityKg,
      allocatedKg,
      indicativePriceKsh: match.buyer.indicativePriceKsh,
      selected: match.selected,
      produceMatch: match.produceMatch,
      timeMatch: match.timeMatch,
      eligible: match.eligible,
      statusLabel: match.statusLabel,
      reasons: match.reasons,
      allocationNote: allocationNote(match, allocatedKg, scenario.quantityKg),
    };
  });
}

function buildRecommendations(
  scenario: ProduceScenario,
  allocations: readonly BuyerAllocation[],
  metrics: DecisionMetrics,
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const anyEligible = allocations.some((allocation) => allocation.eligible);
  const available = metrics.availableQuantityKg;
  const eligibleDemand = metrics.eligibleDemandKg;
  const unallocated = metrics.unallocatedKg;

  if (available === 0) {
    recommendations.push({
      id: "enter-quantity",
      message: "Enter a quantity above zero to estimate what could be matched.",
      explanation:
        "The available quantity is 0 kg, so matched quantity, coverage, and indicative gross sales stay at zero. This follows from the quantity you entered.",
    });
  } else if (!anyEligible) {
    recommendations.push({
      id: "no-eligible-demand",
      message:
        "No eligible buyer demand is available in this scenario. Update your buyer information or seek additional leads.",
      explanation: explainNoEligible(scenario, allocations),
    });
  } else if (unallocated === 0) {
    recommendations.push(
      scenario.mode === "purchase"
        ? {
            id: "demand-covers-purchase",
            message:
              "Eligible buyer demand covers the quantity you are considering. Confirm collection and payment terms before purchasing.",
            explanation: `You entered ${formatKg(available)} and eligible buyers request ${formatKg(eligibleDemand)}, which covers that quantity. This preview does not suggest purchasing more than the quantity you entered.`,
          }
        : {
            id: "demand-covers-available",
            message: "Current buyer demand covers the available quantity. Confirm collection and payment terms.",
            explanation: `Eligible buyers request ${formatKg(eligibleDemand)} and ${formatKg(available)} is available, so the matched quantity equals the full amount. Confirming terms is a suggested next step, not a completed sale.`,
          },
    );
  } else if (scenario.mode === "purchase") {
    recommendations.push({
      id: "purchase-above-demand",
      message: "Do not purchase more produce than eligible buyer demand supports.",
      explanation: `You are considering ${formatKg(available)}, while eligible buyers request ${formatKg(eligibleDemand)}. In this scenario, limit a purchase to ${formatKg(eligibleDemand)} so you are not buying quantity these buyers do not cover.`,
    });
  } else {
    recommendations.push({
      id: "unmatched-surplus",
      message: "Some produce remains unmatched. Contact additional buyers or consider alternative markets.",
      explanation: `Eligible demand is ${formatKg(eligibleDemand)} against ${formatKg(available)} available, leaving ${formatKg(unallocated)} unallocated after filling buyers from the highest indicative price to the lowest.`,
    });
  }

  if (SHORT_SELLING_WINDOWS.includes(scenario.timeRemaining)) {
    recommendations.push({
      id: "short-selling-window",
      message: "Prioritize buyers who can collect within your remaining selling window.",
      explanation: `You have ${scenario.timeRemaining} left to sell. Buyers are eligible only when their collection time fits that window, so confirm those collections before the produce has to move.`,
    });
  }

  const prices = metrics.priceComparison;
  if (
    prices.lowestIndicativeKsh !== null &&
    prices.highestIndicativeKsh !== null &&
    prices.lowestIndicativeKsh !== prices.highestIndicativeKsh
  ) {
    recommendations.push({
      id: "price-tradeoff",
      message:
        "Review the trade-off between buyer price and quantity requested before confirming allocations.",
      explanation: `Eligible indicative prices range from ${formatKshPerKg(prices.lowestIndicativeKsh)} to ${formatKshPerKg(prices.highestIndicativeKsh)}, against your asking price of ${formatKshPerKg(scenario.askingPriceKsh)}. Allocation fills the higher indicative price first, which can leave a lower-priced buyer with less of the quantity.`,
    });
  }

  const excluded = allocations.filter((allocation) => allocation.selected && !allocation.eligible);
  if (excluded.length > 0 && anyEligible) {
    const details = excluded
      .map((allocation) => `${allocation.buyerName}: ${allocation.reasons.join(" ")}`)
      .join(" ");
    recommendations.push({
      id: "excluded-buyers",
      message: "Some selected buyers are outside this match.",
      explanation: `${details} They stay out because produce or collection time does not fit this scenario.`,
    });
  }

  return recommendations;
}

function explainNoEligible(scenario: ProduceScenario, allocations: readonly BuyerAllocation[]): string {
  const included = allocations.filter((allocation) => allocation.selected);
  if (included.length === 0) {
    return `None of the illustrative buyers are included. A buyer is eligible only when they are selected, they request ${scenario.produce}, and they can collect within ${scenario.timeRemaining}.`;
  }
  const details = included.map((allocation) => `${allocation.buyerName}: ${allocation.reasons.join(" ")}`).join(" ");
  return `No buyer currently passes every match rule for ${scenario.produce} with ${scenario.timeRemaining} left to sell. ${details}`;
}

function comparePrices(
  askingPriceKsh: number,
  eligible: readonly BuyerAllocation[],
  potentiallyMatchedKg: number,
  indicativeGrossSalesKsh: number,
): PriceComparison {
  if (eligible.length === 0) {
    return {
      askingPriceKsh,
      lowestIndicativeKsh: null,
      highestIndicativeKsh: null,
      weightedAverageIndicativeKsh: null,
      indicativeAllocationValueKsh: null,
      differenceTotalKsh: null,
      differencePerKgKsh: null,
    };
  }

  const prices = eligible.map((allocation) => allocation.indicativePriceKsh);
  const rawValue = eligible.reduce(
    (sum, allocation) => sum + allocation.allocatedKg * allocation.indicativePriceKsh,
    0,
  );
  const weightedAverage = potentiallyMatchedKg > 0 ? rawValue / potentiallyMatchedKg : null;

  return {
    askingPriceKsh,
    lowestIndicativeKsh: Math.min(...prices),
    highestIndicativeKsh: Math.max(...prices),
    weightedAverageIndicativeKsh: weightedAverage,
    indicativeAllocationValueKsh: roundMoney(rawValue),
    differenceTotalKsh: potentiallyMatchedKg > 0 ? roundMoney(rawValue - indicativeGrossSalesKsh) : null,
    differencePerKgKsh: weightedAverage === null ? null : weightedAverage - askingPriceKsh,
  };
}

function allocationNote(match: BuyerMatch, allocatedKg: number, availableKg: number): string | null {
  if (!match.eligible) return null;
  if (availableKg === 0) return "Nothing to allocate while the available quantity is 0 kg.";
  if (allocatedKg === 0 && match.buyer.quantityKg > 0) {
    return "No quantity left after higher indicative prices were filled.";
  }
  if (allocatedKg < match.buyer.quantityKg) return "Part of this request can be filled from the available quantity.";
  return null;
}

function statusLabel(selected: boolean, produceMatch: boolean, timeMatch: boolean): string {
  if (!produceMatch) return "Produce does not match";
  if (!timeMatch) return "Outside selling window";
  if (!selected) return "Not included";
  return "Eligible";
}

function byPriceThenName(left: BuyerMatch, right: BuyerMatch): number {
  if (right.buyer.indicativePriceKsh !== left.buyer.indicativePriceKsh) {
    return right.buyer.indicativePriceKsh - left.buyer.indicativePriceKsh;
  }
  const byName = left.buyer.name.localeCompare(right.buyer.name);
  if (byName !== 0) return byName;
  return left.buyer.id.localeCompare(right.buyer.id);
}

function assertScenario(scenario: ProduceScenario): void {
  if (!Number.isFinite(scenario.quantityKg) || scenario.quantityKg < 0) {
    throw new Error("quantityKg must be a finite number of zero or more");
  }
  if (!Number.isFinite(scenario.askingPriceKsh) || scenario.askingPriceKsh <= 0) {
    throw new Error("askingPriceKsh must be a finite number greater than zero");
  }
}

function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function priceGapText(comparison: PriceComparison): string | null {
  if (comparison.differencePerKgKsh === null || comparison.weightedAverageIndicativeKsh === null) return null;
  return describePriceGap(comparison.differencePerKgKsh);
}
