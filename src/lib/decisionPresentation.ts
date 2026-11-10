import { formatKg } from "./format";
import type { DecisionMetrics, ScenarioMode } from "../types/decision";

export interface AllocationSegment {
  id: string;
  label: string;
  kilograms: number;
  kind: "allocated" | "unallocated";
  shade: number;
}

export function decisionHeadline(mode: ScenarioMode, metrics: DecisionMetrics): string {
  const matched = formatKg(metrics.potentiallyMatchedKg);
  const unallocated = formatKg(metrics.unallocatedKg);
  const available = formatKg(metrics.availableQuantityKg);
  const eligible = formatKg(metrics.eligibleDemandKg);

  if (metrics.availableQuantityKg === 0) {
    return "Enter a quantity above zero to see what could be matched.";
  }

  if (metrics.eligibleDemandKg === 0) {
    return mode === "purchase"
      ? "No eligible buyer demand covers a purchase in this scenario."
      : "No eligible buyer can take this produce in the current scenario.";
  }

  if (mode === "purchase" && metrics.unallocatedKg > 0) {
    return `Do not purchase more than ${eligible}. ${unallocated} of the ${available} under consideration has no buyer.`;
  }

  if (metrics.unallocatedKg === 0) {
    return mode === "purchase"
      ? `${matched} of the quantity you are considering could be matched. Eligible demand covers it.`
      : `${matched} could be matched to the selected buyers. Nothing in this scenario would remain unallocated.`;
  }

  return `${matched} could be matched to the selected buyers. ${unallocated} remains unallocated.`;
}

export function buildAllocationSegments(
  allocations: readonly { buyerId: string; buyerName: string; allocatedKg: number }[],
  unallocatedKg: number,
): AllocationSegment[] {
  const segments: AllocationSegment[] = [];
  let shade = 0;

  for (const allocation of allocations) {
    if (allocation.allocatedKg <= 0) continue;
    segments.push({
      id: allocation.buyerId,
      label: allocation.buyerName,
      kilograms: allocation.allocatedKg,
      kind: "allocated",
      shade,
    });
    shade += 1;
  }

  if (unallocatedKg > 0) {
    segments.push({
      id: "unallocated",
      label: "Unallocated",
      kilograms: unallocatedKg,
      kind: "unallocated",
      shade: 0,
    });
  }

  return segments;
}

export function segmentShare(kilograms: number, total: number): number {
  if (total <= 0) return 0;
  return (kilograms / total) * 100;
}
