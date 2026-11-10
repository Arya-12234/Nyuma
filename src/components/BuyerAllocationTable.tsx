import { ALLOCATION_RULE } from "../lib/decisionEngine";
import { formatKg, formatKshPerKg } from "../lib/format";
import type { BuyerAllocation } from "../types/decision";

interface BuyerAllocationTableProps {
  allocations: readonly BuyerAllocation[];
}

export function BuyerAllocationTable({ allocations }: BuyerAllocationTableProps) {
  return (
    <section className="record-card" id="allocation" aria-labelledby="allocation-title">
      <div className="block-heading">
        <h3 id="allocation-title">Matches</h3>
        <p>{ALLOCATION_RULE}</p>
      </div>
      <ul className="record-list">
        {allocations.map((allocation) => (
          <li key={allocation.buyerId}>
            <div className="record-main">
              <h4>{allocation.buyerName}</h4>
              <p>
                {allocation.produce} · {allocation.location}
              </p>
            </div>
            <dl>
              <div>
                <dt>Requested</dt>
                <dd>{formatKg(allocation.requestedKg)}</dd>
              </div>
              <div>
                <dt>Allocated</dt>
                <dd>{formatKg(allocation.allocatedKg)}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>{formatKshPerKg(allocation.indicativePriceKsh)}</dd>
              </div>
              <div>
                <dt>Collection</dt>
                <dd>{allocation.collection}</dd>
              </div>
            </dl>
            <p className={allocation.eligible ? "pill pill-ok" : "pill pill-out"}>{outcome(allocation)}</p>
            {allocation.allocationNote ? <p className="alloc-note">{allocation.allocationNote}</p> : null}
            {!allocation.eligible ? <p className="alloc-note">{allocation.reasons.join(" ")}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function outcome(allocation: BuyerAllocation): string {
  if (!allocation.selected) return "Not included";
  if (!allocation.eligible) return allocation.statusLabel;
  if (allocation.allocatedKg <= 0) return "No quantity left";
  if (allocation.allocatedKg < allocation.requestedKg) return "Partly filled";
  return "Matched";
}
