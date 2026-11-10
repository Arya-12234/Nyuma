import type { SessionUser } from "../../lib/auth";
import type { CoordinationAlert, ExposureAudience, ListingExposure } from "../../lib/surplus";
import { exposureReport } from "../../lib/surplus";
import { EmptyState } from "../EmptyState";
import { quantityText, useCoordination } from "./useCoordination";

export function SurplusDesk({ user, audience }: { user: SessionUser; audience: ExposureAudience }) {
  const data = useCoordination(user);
  if (data.phase === "loading") return <p role="status">Loading saved listings…</p>;
  if (data.phase === "error") return <p role="alert">{data.message}</p>;
  const report = exposureReport({
    listings: data.listings,
    demands: data.demands,
    commitments: data.commitments,
    purchases: data.purchases,
    outcomes: data.outcomes,
    audience,
    accountId: user.id,
  });
  const empty = report.upcoming.length === 0 && report.available.length === 0 && report.demands.length === 0;
  const links = linkSet(audience);

  return (
    <div className="record-desk" data-view="exposure">
      <p className="setup-note">{intro(audience, user.sample)}</p>
      {empty ? (
        <EmptyState
          title={audience === "buyer" ? "No open requirement to review." : "Nothing to review yet."}
          body={
            audience === "buyer"
              ? "Exposure for a requirement appears after you save one. Other buyers' requirements are not shown."
              : user.sample
                ? "Exposure appears for open listings saved in this browser. An expected harvest is not unsold surplus."
                : "Exposure appears for open listings on this account. An expected harvest is not unsold surplus."
          }
        />
      ) : null}
      {audience === "trader" || audience === "administrator" ? (
        <dl className="stat-grid">
          <div className="stat">
            <dt>No confirmed agreement</dt>
            <dd>{report.summary.availableUnconfirmedCount === 0 ? "None" : report.summary.availableUnconfirmedCount}</dd>
            <p>Available listings only</p>
          </div>
          <div className="stat">
            <dt>Partly agreed</dt>
            <dd>{report.summary.partialCount === 0 ? "None" : report.summary.partialCount}</dd>
            <p>Available listings with a partial agreement</p>
          </div>
          <div className="stat">
            <dt>Purchased</dt>
            <dd>{quantityText(report.available.length === 0 ? null : report.summary.purchasedKg)}</dd>
            <p>Available listings, each purchase once</p>
          </div>
          <div className="stat">
            <dt>Still exposed</dt>
            <dd>{quantityText(report.available.length === 0 ? null : report.summary.exposedKg)}</dd>
            <p>Available produce not yet recorded as purchased or otherwise accounted for. This is not spoilage.</p>
          </div>
          <div className="stat">
            <dt>Upcoming supply</dt>
            <dd>{quantityText(report.upcoming.length === 0 ? null : report.summary.upcomingKg)}</dd>
            <p>Not ready for collection</p>
          </div>
        </dl>
      ) : null}
      {report.upcoming.length > 0 ? (
        <section className="panel" aria-labelledby="upcoming-supply-title">
          <h3 id="upcoming-supply-title">Upcoming supply — not ready for collection</h3>
          <p className="setup-note">
            Expected harvest is not physically available surplus. Nyuma cannot calculate a ready-to-collect quantity from it.
          </p>
          <ul className="record-list">
            {report.upcoming.map((item) => {
              const listing = data.listings.find((candidate) => candidate.id === item.listingId);
              if (!listing) return null;
              return (
                <li key={item.listingId}>
                  <h4>
                    {listing.commodity} <span className="pill pill-out">Expected harvest</span>
                  </h4>
                  <p>
                    {quantityText(item.listedKg)} expected · {listing.location} · {listing.availabilityWindow}
                  </p>
                  <p>
                    {item.purchasedKg === 0 ? "None purchased." : `${quantityText(item.purchasedKg)} recorded as purchased.`} Confirmed
                    agreements cover {quantityText(item.confirmedKg)}. An agreement is not a purchase.
                  </p>
                  <p>{item.compatibleOpenDemand ? "An open buyer requirement fits this harvest window." : "No compatible open buyer requirement found."}</p>
                  {item.settledOutsidePurchaseKg > 0 ? (
                    <p>
                      {quantityText(item.settledOutsidePurchaseKg)} has a recorded outcome. That does not make this harvest ready to collect.
                    </p>
                  ) : null}
                  {links.listing ? <p><a href={`${links.listing}${listing.id}`}>Update this listing when it is ready</a></p> : null}
                  {links.viewListings ? <p><a href={links.viewListings}>View listings</a></p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {report.available.length > 0 ? (
        <section className="panel" aria-labelledby="available-exposure-title">
          <h3 id="available-exposure-title">Available now</h3>
          <ul className="record-list">
            {report.available.map((item) => {
              const listing = data.listings.find((candidate) => candidate.id === item.listingId);
              if (!listing) return null;
              return (
                <li key={item.listingId}>
                  <h4>
                    {listing.commodity} <span className="pill pill-ok">Available now</span>
                  </h4>
                  <p>
                    {listing.location} · {listing.availabilityWindow}
                  </p>
                  <ul>
                    <li>{quantityText(item.listedKg)} available now.</li>
                    <li>{quantityText(item.purchasedKg)} purchased.</li>
                    {item.settledOutsidePurchaseKg > 0 ? (
                      <li>
                        {quantityText(item.settledOutsidePurchaseKg)} recorded as recovered, spoiled, donated, disposed, or sold outside a saved purchase. That quantity is not still available.
                      </li>
                    ) : null}
                    <li>{quantityText(item.exposedKg)} still exposed.</li>
                    <li>{holdLine(item)}</li>
                    <li>{item.compatibleOpenDemand ? "An open buyer requirement fits this produce and collection window." : "No compatible open buyer requirement found."}</li>
                  </ul>
                  {links.listing ? <p><a href={`${links.listing}${listing.id}`}>Update available quantity</a></p> : null}
                  {links.requirements ? <p><a href={links.requirements}>Review buyer requirements</a></p> : null}
                  {links.viewListings ? <p><a href={links.viewListings}>View listings</a></p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {report.demands.length > 0 ? (
        <section className="panel" aria-labelledby="open-demand-title">
          <h3 id="open-demand-title">Requirements still open</h3>
          <p className="setup-note">
            {audience === "administrator"
              ? user.sample
                ? "These requirements are saved in this browser. They are not platform-wide orders."
                : "These are requirements this account can see. They are not platform-wide orders."
              : "Only your requirements are shown. The uncommitted quantity is not an order."}
          </p>
          <ul className="record-list">
            {report.demands.map((item) => {
              const requirement = data.demands.find((candidate) => candidate.id === item.demandId);
              if (!requirement) return null;
              return (
                <li key={item.demandId}>
                  <h4>{requirement.commodity}</h4>
                  <ul>
                    <li>{quantityText(item.requestedKg)} requested.</li>
                    <li>{quantityText(item.heldKg)} held by agreements.</li>
                    <li>{quantityText(item.remainingKg)} still has no agreement.</li>
                  </ul>
                  {links.demand ? <p><a href={`${links.demand}${requirement.id}`}>Review this requirement</a></p> : null}
                  {links.viewDemands ? <p><a href={links.viewDemands}>View requirements</a></p> : null}
                  {links.produce ? <p><a href={links.produce}>Review available produce</a></p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <section className="panel" aria-labelledby="exposure-alerts-title">
        <h3 id="exposure-alerts-title">What to review</h3>
        <p className="setup-note">These notes follow the saved records. They do not predict spoilage or guarantee a sale.</p>
        {report.alerts.length === 0 ? (
          <EmptyState title="Nothing needs attention." body="There is no exposure note for the open records in this view." />
        ) : (
          <ul className="record-list">
            {report.alerts.map((alert) => (
              <li key={alert.id} className={alert.tone === "warning" ? "tone-warning" : "tone-info"}>
                <h4>{alert.tone === "warning" ? "Needs a decision" : "For your information"}</h4>
                <p>{alert.detected}</p>
                <p>{alert.quantityKg === null ? "Quantity not calculated." : `Quantity involved: ${quantityText(alert.quantityKg)}.`}</p>
                <p>{alert.why}</p>
                <p>{alert.action}</p>
                <AlertLinks alert={alert} audience={audience} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function holdLine(item: ListingExposure): string {
  if (item.heldKg === 0) return "No agreement is holding quantity.";
  const proposed = item.proposedKg > 0 ? ` ${quantityText(item.proposedKg)} of that is only proposed.` : "";
  return `${quantityText(item.heldKg)} is held by agreements. ${quantityText(item.confirmedKg)} is confirmed.${proposed} ${quantityText(item.uncommittedKg)} of the listing has no agreement.`;
}

function AlertLinks({ alert, audience }: { alert: CoordinationAlert; audience: ExposureAudience }) {
  const links = linkSet(audience);
  if (alert.id.startsWith("demand-remaining")) {
    return (
      <p>
        {links.produce ? <a href={links.produce}>Review available produce</a> : null}
        {links.viewDemands ? <a href={links.viewDemands}> View requirements</a> : null}
        {links.agreement ? <a href={links.agreement}> Review agreements</a> : null}
      </p>
    );
  }
  if (alert.id.startsWith("commitment-unpurchased")) {
    return (
      <p>
        {links.purchase ? <a href={`${links.purchase}${alert.subjectId}`}>Record a purchase</a> : null}
        {links.agreements ? <a href={links.agreements}> Review agreements</a> : null}
        {links.viewTransactions ? <a href={links.viewTransactions}> View agreements</a> : null}
      </p>
    );
  }
  return (
    <p>
      {links.listing ? <a href={`${links.listing}${alert.subjectId}`}>Update the listing</a> : null}
      {links.requirements ? <a href={links.requirements}> Review buyer requirements</a> : null}
      {links.agreements ? <a href={links.agreements}> Review agreements</a> : null}
      {links.viewListings ? <a href={links.viewListings}> View listings</a> : null}
    </p>
  );
}

function intro(audience: ExposureAudience, sample: boolean): string {
  if (audience === "administrator") {
    return sample
      ? "These figures are records saved in this browser. They are not platform-wide statistics. This page is view only."
      : "These figures are records for this account. They are not platform-wide statistics. This page is view only.";
  }
  if (audience === "buyer") {
    return "This shows quantity on your requirements that has no agreement yet. Confirmed agreements and purchases stay separate. Other buyers' requirements are not shown.";
  }
  if (audience === "trader") {
    return "These figures come from your saved listings. The demonstration scenario is separate, and a possible match there is not an agreement.";
  }
  return "These figures come from your saved listings. Expected harvest is shown apart from produce that is ready to collect.";
}

function linkSet(audience: ExposureAudience): {
  listing: string | null;
  requirements: string | null;
  agreements: string | null;
  agreement: string | null;
  purchase: string | null;
  produce: string | null;
  demand: string | null;
  viewListings: string | null;
  viewDemands: string | null;
  viewTransactions: string | null;
} {
  if (audience === "farmer") {
    return {
      listing: "#farmer-listing?id=",
      requirements: "#farmer-opportunities",
      agreements: "#farmer-commitments",
      agreement: "#farmer-commitment",
      purchase: "#farmer-purchase?id=",
      produce: null,
      demand: null,
      viewListings: null,
      viewDemands: null,
      viewTransactions: null,
    };
  }
  if (audience === "trader") {
    return {
      listing: "#stock-form?id=",
      requirements: "#buyers",
      agreements: "#transactions",
      agreement: "#trader-commitment",
      purchase: "#trader-purchase?id=",
      produce: null,
      demand: null,
      viewListings: null,
      viewDemands: null,
      viewTransactions: null,
    };
  }
  if (audience === "buyer") {
    return {
      listing: null,
      requirements: null,
      agreements: "#buyer-commitments",
      agreement: "#buyer-commitment",
      purchase: "#buyer-purchase?id=",
      produce: "#buyer-produce",
      demand: "#buyer-demand-form?id=",
      viewListings: null,
      viewDemands: null,
      viewTransactions: null,
    };
  }
  return {
    listing: null,
    requirements: null,
    agreements: null,
    agreement: null,
    purchase: null,
    produce: null,
    demand: null,
    viewListings: "#admin-listings",
    viewDemands: "#admin-demand",
    viewTransactions: "#admin-transactions",
  };
}
