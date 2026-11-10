import { PUBLISHED_PARTY } from "../../lib/accountCoordination";
import type { BuyerDemand } from "../../domain/records";
import type { SessionUser } from "../../lib/auth";
import { SAMPLE_USERS } from "../../lib/sampleUsers";
import { formatKsh } from "../../lib/format";
import {
  TRADER_EXPLANATIONS,
  matchTraderListings,
  summarizeTrader,
  traderOutcomeSummary,
  type TraderListingMatch,
  type TraderOverview,
} from "../../lib/traderRecords";
import { EmptyState } from "../EmptyState";
import { priceText, quantityText, type CoordinationLoad } from "../coordination/useCoordination";

export function TraderOverviewView({ user, data }: { user: SessionUser; data: CoordinationLoad }) {
  if (data.phase !== "ready") return <Pending data={data} label="Checking saved records…" />;
  const summary = summarizeTrader(user.id, data);
  const bare =
    summary.openListingCount === 0 &&
    summary.draftCount === 0 &&
    summary.confirmedCount === 0 &&
    summary.proposedCount === 0 &&
    summary.cancelledCount === 0 &&
    summary.purchaseCount === 0;

  return (
    <div data-view="trader-overview">
      <p className="setup-note">
        {user.sample
          ? "These figures are saved records in this browser. They are not the practice scenario."
          : "These figures are saved for this account. They are not the practice scenario."}
      </p>
      {bare ? (
        <EmptyState
          title="No saved trade records yet."
          body="Add produce you are selling. Buyer requirements, agreements, and purchases appear here after they are recorded. The practice scenario does not fill this page."
        />
      ) : null}
      <ActionLinks />
      <Supply summary={summary} sample={user.sample} />
      <Demand summary={summary} />
      <Agreements summary={summary} />
      <Purchases summary={summary} />
      <Exposure summary={summary} />
    </div>
  );
}

export function TraderDemandView({ data, sample = true }: { data: CoordinationLoad; sample?: boolean }) {
  if (data.phase !== "ready") return <Pending data={data} label="Checking saved requirements…" />;
  const open = data.demands.filter((demand) => demand.status === "open");
  const closed = data.demands.filter((demand) => demand.status !== "open");
  return (
    <div data-view="trader-demand">
      <p className="setup-note">{TRADER_EXPLANATIONS.requirement}</p>
      <p className="setup-note">{TRADER_EXPLANATIONS.indicativePrice}</p>
      {open.length === 0 ? (
        <EmptyState
          title="No open buyer requirements."
          body={
            sample
              ? "When a buyer saves a requirement in this browser, it shows here. Publishing a requirement does not create an order."
              : "Open requirements from the market show here. Publishing a requirement does not create an order."
          }
        />
      ) : (
        <DemandList demands={open} sample={sample} />
      )}
      {closed.length > 0 ? (
        <section className="panel" aria-labelledby="closed-demand-title">
          <h3 id="closed-demand-title">Not open</h3>
          <p className="setup-note">Closed and withdrawn requirements are not used for suggestions.</p>
          <DemandList demands={closed} sample={sample} />
        </section>
      ) : null}
      <p>
        <a href="#allocation">Review potential matches</a>
      </p>
    </div>
  );
}

export function TraderMatchesView({ user, data }: { user: SessionUser; data: CoordinationLoad }) {
  if (data.phase !== "ready") return <Pending data={data} label="Checking saved listings…" />;
  const matches = matchTraderListings(user.id, data.listings, data.demands);
  return (
    <div data-view="trader-matches">
      <p className="setup-note">{TRADER_EXPLANATIONS.potentialMatch}</p>
      <p className="setup-note">{TRADER_EXPLANATIONS.indicativePrice}</p>
      {matches.length === 0 ? (
        <EmptyState
          title="No listings to compare."
          body="Add an open listing first. A suggestion appears only when a saved buyer requirement can be compared. Nothing is agreed automatically."
        />
      ) : (
        <ul className="record-list">
          {matches.map((match) => (
            <li key={match.listingId}>
              <MatchCard match={match} sample={user.sample} />
            </li>
          ))}
        </ul>
      )}
      <p>
        <a href="#trader-commitment">Record an agreement</a>
        {" · "}
        <a href="#buyers">Review buyer requirements</a>
      </p>
      <p className="setup-note">Recording an agreement is a separate step. This page does not save one.</p>
    </div>
  );
}

export function TraderAnalyticsView({ user, data }: { user: SessionUser; data: CoordinationLoad }) {
  if (data.phase !== "ready") return <Pending data={data} label="Checking saved records…" />;
  const summary = summarizeTrader(user.id, data);
  const outcomes = traderOutcomeSummary(user.id, data);
  return (
    <div data-view="trader-analytics">
      <p className="setup-note">These figures use your saved records. They are not the practice scenario, and they are not profit.</p>
      {summary.openListingCount === 0 && summary.purchaseCount === 0 && outcomes.listedKg === 0 ? (
        <EmptyState title="No saved figures yet." body="Analytics stays empty until you save a listing or a purchase." />
      ) : null}
      <dl className="supply-board">
        <Stat term="Available now" value={quantityText(summary.availableNowKg)} note={TRADER_EXPLANATIONS.availableNow} />
        <Stat term="Expected harvest" value={quantityText(summary.expectedHarvestKg)} note={TRADER_EXPLANATIONS.expectedHarvest} />
        <Stat term="Committed" value={quantityText(summary.confirmedKg)} note={TRADER_EXPLANATIONS.committed} />
        <Stat term="Purchased" value={quantityText(summary.purchasedKg)} note={TRADER_EXPLANATIONS.purchased} />
        <Stat term="Still exposed" value={summary.openListingCount === 0 ? "None" : quantityText(summary.exposedKg)} note={TRADER_EXPLANATIONS.exposed} />
        <Stat term="Unaccounted" value={outcomes.listedKg === 0 ? "None" : quantityText(outcomes.unaccountedKg)} note={TRADER_EXPLANATIONS.unaccounted} />
      </dl>
      {outcomes.listedKg > 0 ? (
        <p className="setup-note">
          {quantityText(outcomes.noOutcomeKg)} has no outcome record. A purchase can sit in that figure until someone records a sold outcome. That is not spoilage.
        </p>
      ) : null}
    </div>
  );
}

function Supply({ summary, sample }: { summary: TraderOverview; sample: boolean }) {
  return (
    <section aria-labelledby="supply-title">
      <h3 id="supply-title">Supply</h3>
      <dl className="supply-board">
        <Stat term="Open listings" value={String(summary.openListingCount)} note={sample ? "Listings you have open in this browser." : "Listings you have open for this account."} />
        <Stat term="Listed quantity" value={quantityText(summary.listedKg)} note="Open listings only. Drafts are not included." />
        <Stat term="Available now" value={quantityText(summary.availableNowKg)} note={TRADER_EXPLANATIONS.availableNow} />
        <Stat term="Expected harvest" value={quantityText(summary.expectedHarvestKg)} note={TRADER_EXPLANATIONS.expectedHarvest} />
      </dl>
      {summary.draftCount > 0 ? (
        <p className="setup-note">
          {summary.draftCount} draft {summary.draftCount === 1 ? "listing is" : "listings are"} not open.{" "}
          <a href="#stock">Review drafts</a>
        </p>
      ) : null}
    </section>
  );
}

function Demand({ summary }: { summary: TraderOverview }) {
  return (
    <section aria-labelledby="demand-title">
      <h3 id="demand-title">Demand</h3>
      <dl className="supply-board">
        <Stat
          term="Compatible requirements"
          value={String(summary.compatibleRequirementCount)}
          note={`${TRADER_EXPLANATIONS.requirement} A fit with an expected harvest is for planning only.`}
        />
      </dl>
    </section>
  );
}

function Agreements({ summary }: { summary: TraderOverview }) {
  return (
    <section aria-labelledby="agreement-title">
      <h3 id="agreement-title">Agreements</h3>
      <dl className="supply-board">
        <Stat term="Confirmed" value={`${summary.confirmedCount} · ${quantityText(summary.confirmedKg)}`} note={TRADER_EXPLANATIONS.committed} />
        <Stat term="Proposed" value={String(summary.proposedCount)} note="Proposed quantity is not a confirmed agreement." />
        <Stat term="Cancelled" value={String(summary.cancelledCount)} note="Cancelled agreements are not included in the confirmed quantity." />
      </dl>
      {summary.fulfilledCount > 0 ? (
        <p className="setup-note">{summary.fulfilledCount} fulfilled. A fulfilled agreement is not added to the confirmed quantity.</p>
      ) : null}
    </section>
  );
}

function Purchases({ summary }: { summary: TraderOverview }) {
  return (
    <section aria-labelledby="purchase-title">
      <h3 id="purchase-title">Purchases</h3>
      <dl className="supply-board">
        <Stat
          term="Recorded purchases"
          value={`${summary.purchaseCount} · ${quantityText(summary.purchasedKg)}`}
          note={TRADER_EXPLANATIONS.purchased}
        />
      </dl>
    </section>
  );
}

function Exposure({ summary }: { summary: TraderOverview }) {
  return (
    <section aria-labelledby="exposure-title">
      <h3 id="exposure-title">Exposure</h3>
      <dl className="supply-board">
        <Stat
          term="Still exposed"
          value={summary.openListingCount === 0 ? "None" : quantityText(summary.exposedKg)}
          note={TRADER_EXPLANATIONS.exposed}
        />
        <Stat term="Expected harvest" value={quantityText(summary.upcomingKg === 0 ? null : summary.upcomingKg)} note="Kept separate. This is not ready-to-collect surplus." />
      </dl>
      <p>
        <a href="#trader-exposure">Open the exposure detail</a>
      </p>
    </section>
  );
}

function MatchCard({ match, sample }: { match: TraderListingMatch; sample: boolean }) {
  return (
    <article>
      <h3>
        {match.commodity}{" "}
        <span className={match.planning ? "pill pill-out" : "pill pill-ok"}>
          {match.planning ? "Expected harvest" : "Available now"}
        </span>
      </h3>
      <p>
        {quantityText(match.quantity)} listed · {match.status}
      </p>
      {match.planning ? <p>{TRADER_EXPLANATIONS.expectedHarvest}</p> : <p>{TRADER_EXPLANATIONS.availableNow}</p>}
      {match.explanation ? <p role="status">{match.explanation}</p> : null}
      {match.suggestions.length === 0 && match.status === "open" && !match.explanation ? (
        <p>No quantity was suggested. {quantityText(match.unallocatedKg)} was not allocated.</p>
      ) : null}
      {match.suggestions.map((suggestion) => (
        <div key={suggestion.demandId} className="confirm-panel">
          <h4>{suggestion.label}</h4>
          <p>
            {suggestion.commodity} · {accountLabel(suggestion.buyerId, sample)}
          </p>
          <dl>
            <div>
              <dt>Listing quantity</dt>
              <dd>{quantityText(suggestion.listingQuantityKg)}</dd>
            </div>
            <div>
              <dt>Requirement quantity</dt>
              <dd>{quantityText(suggestion.requirementQuantityKg)}</dd>
            </div>
            <div>
              <dt>Suggested quantity</dt>
              <dd>{quantityText(suggestion.suggestedKg)}</dd>
            </div>
            <div>
              <dt>Indicative price</dt>
              <dd>{priceText(suggestion.indicativePriceKsh)}</dd>
            </div>
            <div>
              <dt>Not allocated</dt>
              <dd>{quantityText(suggestion.unallocatedKg)}</dd>
            </div>
          </dl>
          <p>{suggestion.why}</p>
          <p>{TRADER_EXPLANATIONS.indicativePrice}</p>
        </div>
      ))}
      {match.suggestions.length > 0 && match.indicativeGrossSalesKsh !== null && match.indicativeGrossSalesKsh > 0 ? (
        <p>
          Indicative value at your asking price: {formatKsh(match.indicativeGrossSalesKsh)}. This is not confirmed revenue.
        </p>
      ) : null}
      {match.incompatible.length > 0 ? (
        <div>
          <h4>Not compatible</h4>
          <ul>
            {match.incompatible.map((gap) => (
              <li key={gap.demandId}>
                {gap.commodity} · {accountLabel(gap.buyerId, sample)}. {gap.why}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function DemandList({ demands, sample }: { demands: readonly BuyerDemand[]; sample: boolean }) {
  return (
    <ul className="record-list">
      {demands.map((demand) => (
        <li key={demand.id}>
          <h3>
            {demand.commodity} <span className="pill pill-ok">{demand.status}</span>
          </h3>
          <p>
            {quantityText(demand.requestedQuantity)} · {demand.preferredLocation} · {demand.collectionWindow}
          </p>
          <p>
            {priceText(demand.indicativePriceKshPerKg)} · {accountLabel(demand.buyerId, sample)}
          </p>
          <p>{TRADER_EXPLANATIONS.requirement}</p>
        </li>
      ))}
    </ul>
  );
}

function ActionLinks() {
  return (
    <p className="quick-links">
      <a href="#stock-form">Add produce</a>
      <a href="#buyers">Buyer requirements</a>
      <a href="#allocation">Potential matches</a>
      <a href="#trader-commitment">Record an agreement</a>
      <a href="#practice-scenario">Practice scenario</a>
    </p>
  );
}

function Stat({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{value}</dd>
      <p>{note}</p>
    </div>
  );
}

function Pending({ data, label }: { data: CoordinationLoad; label: string }) {
  if (data.phase === "error") return <p role="alert">{data.message}</p>;
  return <p role="status">{label}</p>;
}

function accountLabel(id: string, sample: boolean): string {
  if (!sample) {
    if (id === PUBLISHED_PARTY) return "Published requirement";
    return "Requirement";
  }
  if (id === PUBLISHED_PARTY) return "A buyer";
  const known = SAMPLE_USERS.find((account) => account.id === id);
  return known ? `${known.name}, sample account` : id;
}
