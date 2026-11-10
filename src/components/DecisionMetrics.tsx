import { priceGapText } from "../lib/decisionEngine";
import { formatKg, formatKsh, formatKshPerKg, formatPercent } from "../lib/format";
import type { DecisionMetrics as Metrics, ScenarioMode } from "../types/decision";

interface DecisionMetricsProps {
  metrics: Metrics;
  mode: ScenarioMode;
}

export function DecisionMetrics({ metrics, mode }: DecisionMetricsProps) {
  const comparison = metrics.priceComparison;
  const gap = priceGapText(comparison);
  const range =
    comparison.lowestIndicativeKsh === null || comparison.highestIndicativeKsh === null
      ? null
      : comparison.lowestIndicativeKsh === comparison.highestIndicativeKsh
        ? formatKshPerKg(comparison.lowestIndicativeKsh)
        : `${formatKshPerKg(comparison.lowestIndicativeKsh)}–${formatKshPerKg(comparison.highestIndicativeKsh)}`;

  return (
    <section className="summary" aria-labelledby="metrics-title">
      <h3 id="metrics-title" className="sr-only">
        Decision summary
      </h3>
      <dl className="stat-grid">
        <div className="stat stat-stock" data-metric="available">
          <dt>{mode === "purchase" ? "Quantity to consider (kg)" : "Available supply (kg)"}</dt>
          <dd>{plainKg(metrics.availableQuantityKg)}</dd>
          <p>{mode === "purchase" ? "Under consideration" : "In this scenario"}</p>
        </div>
        <div className="stat stat-sold" data-metric="matched">
          <dt>Matched quantity (kg)</dt>
          <dd>{plainKg(metrics.potentiallyMatchedKg)}</dd>
          <p data-metric="coverage">
            {metrics.demandCoveragePercent === null
              ? "Coverage unavailable"
              : `${formatPercent(metrics.demandCoveragePercent)} of the load`}
          </p>
        </div>
        <div
          className={metrics.unallocatedKg > 0 ? "stat stat-surplus is-surplus" : "stat stat-surplus"}
          data-metric="unallocated"
        >
          <dt>Uncommitted supply (kg)</dt>
          <dd>{plainKg(metrics.unallocatedKg)}</dd>
          <p>{metrics.unallocatedKg > 0 ? "Needs buyers" : "Fully matched"}</p>
        </div>
        <div className="stat stat-revenue" data-metric="gross-sales">
          <dt>Est. gross sales (KSh)</dt>
          <dd>{plainKsh(metrics.indicativeGrossSalesKsh)}</dd>
          <p>Matched quantity at your asking price</p>
        </div>
      </dl>
      <p className="sales-caveat" data-metric="eligible-demand">
        Eligible buyer demand is {formatKg(metrics.eligibleDemandKg)}. Gross sales are not profit and exclude
        transport, commissions, and market fees.
      </p>
      {range ? (
        <p className="price-line">
          Asking price {formatKshPerKg(comparison.askingPriceKsh)}. Eligible buyers indicate {range}
          {gap && comparison.weightedAverageIndicativeKsh !== null
            ? `. The allocated average is ${formatKshPerKg(comparison.weightedAverageIndicativeKsh)}, which is ${gap}.`
            : "."}{" "}
          {comparison.differenceTotalKsh !== null && comparison.indicativeAllocationValueKsh !== null
            ? `At those indicative prices the allocated quantity would total ${formatKsh(comparison.indicativeAllocationValueKsh)}, ${describeTotalGap(comparison.differenceTotalKsh)}. `
            : ""}
          These prices have not been agreed.
        </p>
      ) : (
        <p className="price-line">No eligible buyer price is available to compare with the asking price.</p>
      )}
    </section>
  );
}

function plainKg(value: number): string {
  return formatKg(value).replace(/ kg$/, "");
}

function plainKsh(value: number): string {
  return formatKsh(value).replace(/^KSh\s/, "");
}

function describeTotalGap(difference: number): string {
  if (Math.abs(difference) < 0.005) return "the same as the asking-price total";
  if (difference > 0) return `${formatKsh(difference)} above the asking-price total`;
  return `${formatKsh(Math.abs(difference))} below the asking-price total`;
}
