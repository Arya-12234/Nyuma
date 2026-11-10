import { recordIdFromHash, type WorkspaceSection } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { EMPTY } from "../../lib/workspaceContent";
import { confirmedCommitmentCount, confirmedQuantityKg, commitmentsForSide, purchasedQuantityKg, purchasesForCommitments } from "../../lib/coordinationActivity";
import { demandsForAccount, openRequestedQuantity } from "../../lib/coordinationWorkflow";
import { AgreementDesk } from "../coordination/AgreementDesk";
import { OutcomeDesk } from "../coordination/OutcomeDesk";
import { SurplusDesk } from "../coordination/SurplusDesk";
import { DemandManager } from "../coordination/DemandManager";
import { EmptyState } from "../EmptyState";
import { priceText, quantityText, useCoordination } from "../coordination/useCoordination";

export function BuyerWorkspace({
  user,
  section,
  hash,
}: {
  user: SessionUser;
  section: WorkspaceSection;
  hash: string;
}) {
  if (section.id === "buyer-demand") {
    return <DemandManager user={user} mode="list" formHash="#buyer-demand-form" listHash="#buyer-demand" recordId={null} />;
  }
  if (section.id === "buyer-demand-form") {
    return (
      <DemandManager
        user={user}
        mode="form"
        formHash="#buyer-demand-form"
        listHash="#buyer-demand"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "buyer-overview") return <BuyerOverview user={user} />;
  if (section.id === "buyer-exposure") return <SurplusDesk user={user} audience="buyer" />;
  if (section.id === "buyer-outcomes") return <OutcomeDesk user={user} mode="buyer" />;
  if (section.id === "buyer-produce") return <AvailableProduce user={user} />;
  if (section.id === "buyer-matches") {
    return (
      <EmptyState
        title="No potential supply matches."
        body="A requirement does not create a match. Matches are not recorded yet."
      />
    );
  }
  if (section.id === "buyer-commitments" || section.id === "buyer-commitment-form" || section.id === "buyer-purchase-form" || section.id === "buyer-purchases") {
    const mode =
      section.id === "buyer-commitment-form" ? "form" : section.id === "buyer-purchase-form" ? "purchase" : section.id === "buyer-purchases" ? "purchases" : "list";
    return (
      <AgreementDesk
        user={user}
        mode={mode}
        side="demand"
        listHash={section.id === "buyer-purchases" ? "#buyer-purchases" : "#buyer-commitments"}
        formHash="#buyer-commitment"
        purchaseHash="#buyer-purchase"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  return <EmptyState {...EMPTY.messages} />;
}

function BuyerOverview({ user }: { user: SessionUser }) {
  const data = useCoordination(user);
  const mine = data.phase === "ready" ? demandsForAccount(data.demands, user.id) : [];
  const open = mine.filter((demand) => demand.status === "open");
  const requested = data.phase === "ready" ? openRequestedQuantity(open) : null;
  const available = data.phase === "ready" ? data.listings.filter((listing) => listing.status === "open" && listing.quantityKind === "available") : [];
  const agreements = data.phase === "ready" ? commitmentsForSide(data.commitments, data.listings, data.demands, user.id, "demand") : [];
  const confirmedKg = data.phase === "ready" ? confirmedQuantityKg(agreements) : null;
  const purchased = data.phase === "ready" ? purchasesForCommitments(data.purchases, agreements) : [];

  return (
    <>
      {data.phase === "loading" ? <p role="status">Loading your requirements…</p> : null}
      {data.phase === "error" ? <p role="alert">{data.message}</p> : null}
      <dl className="stat-grid">
        <div className="stat">
          <dt>Open requirements</dt>
          <dd>{data.phase === "ready" ? open.length : "…"}</dd>
          <p>{data.phase === "ready" && open.length === 0 ? "None submitted" : "Not confirmed orders"}</p>
        </div>
        <div className="stat">
          <dt>Requested quantity</dt>
          <dd>{data.phase === "ready" ? quantityText(requested) : "…"}</dd>
          <p>From open requirements</p>
        </div>
        <div className="stat">
          <dt>Available produce</dt>
          <dd>{data.phase === "ready" ? available.length : "…"}</dd>
          <p>Open listings marked available now</p>
        </div>
        <div className="stat">
          <dt>Confirmed agreements</dt>
          <dd>{data.phase === "ready" ? (confirmedCommitmentCount(agreements) === 0 ? "None" : confirmedCommitmentCount(agreements)) : "…"}</dd>
          <p>{data.phase === "ready" ? quantityText(confirmedKg) : user.sample ? "Checking this browser" : "Checking this account"} · not purchases</p>
        </div>
        <div className="stat">
          <dt>Purchased quantity</dt>
          <dd>{data.phase === "ready" ? quantityText(purchasedQuantityKg(purchased)) : "…"}</dd>
          <p>{data.phase !== "ready" ? (user.sample ? "Checking this browser" : "Checking this account") : purchased.length === 0 ? "None recorded" : "Each purchase counted once"}</p>
        </div>
      </dl>
      {data.phase === "ready" && mine.length === 0 ? (
        <EmptyState
          title="You haven't submitted any purchasing requirements."
          body="Add your demand to discover available produce."
        />
      ) : null}
      <p>
        <a className="btn btn-lime" href="#buyer-demand-form">
          Submit a requirement
        </a>
      </p>
      <p>
        <a href="#buyer-exposure">Review quantity with no agreement</a>
      </p>
      <p>
        <a href="#buyer-outcomes">Review sold outcomes linked to your purchases</a>
      </p>
    </>
  );
}

function AvailableProduce({ user }: { user: SessionUser }) {
  const data = useCoordination(user);
  if (data.phase === "loading") return <p role="status">Loading available produce…</p>;
  if (data.phase === "error") return <p role="alert">{data.message}</p>;
  const available = data.listings.filter((listing) => listing.status === "open" && listing.quantityKind === "available");
  if (available.length === 0) {
    return (
      <EmptyState
        title="No produce is available to review."
        body="Only produce marked as available now is shown. Expected harvest is not ready to collect."
      />
    );
  }
  return (
    <section className="panel">
      <h3>Available now</h3>
      <p className="setup-note">Expected harvest is not shown here. These listings are not confirmed sales.</p>
      <ul className="record-list">
        {available.map((listing) => (
          <li key={listing.id}>
            <h4>{listing.commodity}</h4>
            <p>
              {quantityText(listing.quantity)} · {listing.location} · {listing.availabilityWindow} ·{" "}
              {priceText(listing.askingPriceKshPerKg)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
