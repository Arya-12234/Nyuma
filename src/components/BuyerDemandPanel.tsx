import { formatKg, formatKshPerKg } from "../lib/format";
import type { BuyerMatch } from "../types/decision";

interface BuyerDemandPanelProps {
  matches: readonly BuyerMatch[];
  onToggle: (buyerId: string) => void;
}

export function BuyerDemandPanel({ matches, onToggle }: BuyerDemandPanelProps) {
  const included = matches.filter((match) => match.selected).length;

  return (
    <fieldset className="buyer-select" id="buyers">
      <legend>
        Buyer matching
        <span>
          {included} of {matches.length} included
        </span>
      </legend>
      <p className="setup-note">
        Illustrative buyers. Include a buyer to count their demand. A buyer is eligible only when the produce matches
        and they can collect in the selling window.
      </p>
      {matches.every((match) => !match.eligible) ? (
        <p className="empty-note">No buyer in this scenario can take the selected crop.</p>
      ) : null}
      <ul className="match-list">
        {matches.map((match) => (
          <li key={match.buyer.id}>
            <article className={match.eligible ? "match-card is-on" : "match-card"}>
              <div>
                <h4>{match.buyer.name}</h4>
                <p>
                  {match.buyer.location} · {match.buyer.produce}
                </p>
                <p className="match-meta">
                  Accepts {formatKg(match.buyer.quantityKg)} · {formatKshPerKg(match.buyer.indicativePriceKsh)} ·{" "}
                  {match.buyer.collection}
                </p>
                <p className={match.eligible ? "status status-eligible" : "status status-out"}>{match.statusLabel}</p>
                {!match.eligible ? <p className="buyer-reason">{match.reasons.join(" ")}</p> : null}
              </div>
              <label className={match.selected ? "include is-included" : "include"}>
                <input type="checkbox" checked={match.selected} onChange={() => onToggle(match.buyer.id)} />
                <span>{match.selected ? "Included" : "Include"}</span>
                <span className="sr-only">{match.buyer.name}</span>
              </label>
            </article>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
