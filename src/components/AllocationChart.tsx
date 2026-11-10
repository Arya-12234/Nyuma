import { buildAllocationSegments, segmentShare } from "../lib/decisionPresentation";
import { formatKg, formatPercent } from "../lib/format";
import type { BuyerAllocation, DecisionMetrics } from "../types/decision";

interface AllocationChartProps {
  allocations: readonly BuyerAllocation[];
  metrics: DecisionMetrics;
}

export function AllocationChart({ allocations, metrics }: AllocationChartProps) {
  const segments = buildAllocationSegments(allocations, metrics.unallocatedKg);
  const total = metrics.availableQuantityKg;

  return (
    <figure className="allocation-figure">
      <figcaption>
        <span>This load</span>
        <span>Available quantity, by buyer</span>
      </figcaption>
      {total <= 0 || segments.length === 0 ? (
        <p className="empty-note">No quantity to split until the available amount is above zero.</p>
      ) : (
        <>
          <div className="stack" role="img" aria-label={segments.map((segment) => `${segment.label} ${formatKg(segment.kilograms)}`).join(", ")}>
            {segments.map((segment) => (
              <span
                key={segment.id}
                className={segment.kind === "unallocated" ? "stack-seg is-surplus" : `stack-seg shade-${segment.shade % 3}`}
                style={{ width: `${segmentShare(segment.kilograms, total)}%` }}
              />
            ))}
          </div>
          <ul className="stack-legend">
            {segments.map((segment) => (
              <li key={segment.id}>
                <span
                  className={segment.kind === "unallocated" ? "swatch is-surplus" : `swatch shade-${segment.shade % 3}`}
                  aria-hidden="true"
                />
                <span>{segment.label}</span>
                <strong>
                  {formatKg(segment.kilograms)} · {formatPercent(segmentShare(segment.kilograms, total))}
                </strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}
