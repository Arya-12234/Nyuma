import { recordIdFromHash, type WorkspaceSection } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { roleLabel } from "../../lib/sampleUsers";
import { EMPTY } from "../../lib/workspaceContent";
import { confirmedCommitmentCount, confirmedQuantityKg, commitmentsForSide, purchasedQuantityKg, purchasesForCommitments } from "../../lib/coordinationActivity";
import { listingsForAccount, openQuantity } from "../../lib/coordinationWorkflow";
import { EmptyState } from "../EmptyState";
import { AgreementDesk } from "../coordination/AgreementDesk";
import { OutcomeDesk } from "../coordination/OutcomeDesk";
import { SurplusDesk } from "../coordination/SurplusDesk";
import { ListingManager } from "../coordination/ListingManager";
import { priceText, quantityText, useCoordination } from "../coordination/useCoordination";

export function FarmerWorkspace({
  user,
  section,
  hash,
}: {
  user: SessionUser;
  section: WorkspaceSection;
  hash: string;
}) {
  if (section.id === "farmer-listings") {
    return <ListingManager user={user} mode="list" formHash="#farmer-listing" listHash="#farmer-listings" recordId={null} />;
  }
  if (section.id === "farmer-listing-form") {
    return (
      <ListingManager
        user={user}
        mode="form"
        formHash="#farmer-listing"
        listHash="#farmer-listings"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "farmer-overview") return <FarmerOverview user={user} />;
  if (section.id === "farmer-opportunities") return <FarmerOpportunities user={user} />;
  if (section.id === "farmer-commitments") {
    return (
      <AgreementDesk
        user={user}
        mode="list"
        side="listing"
        listHash="#farmer-commitments"
        formHash="#farmer-commitment"
        purchaseHash="#farmer-purchase"
        recordId={null}
      />
    );
  }
  if (section.id === "farmer-commitment-form") {
    return (
      <AgreementDesk
        user={user}
        mode="form"
        side="listing"
        listHash="#farmer-commitments"
        formHash="#farmer-commitment"
        purchaseHash="#farmer-purchase"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "farmer-purchase-form") {
    return (
      <AgreementDesk
        user={user}
        mode="purchase"
        side="listing"
        listHash="#farmer-commitments"
        formHash="#farmer-commitment"
        purchaseHash="#farmer-purchase"
        recordId={recordIdFromHash(hash)}
      />
    );
  }
  if (section.id === "farmer-exposure") return <SurplusDesk user={user} audience="farmer" />;
  if (section.id === "farmer-outcomes") return <OutcomeDesk user={user} mode="record" />;
  if (section.id === "farmer-matches") {
    return (
      <EmptyState
        title="No matches yet."
        body="Saving a listing does not create a match, a commitment, or a sale."
      />
    );
  }
  if (section.id === "farmer-messages") return <EmptyState {...EMPTY.messages} />;

  return (
    <section className="panel" aria-labelledby="profile-title">
      <h3 id="profile-title">{user.sample ? "Sample account" : "Account"}</h3>
      <p className="setup-note">
        {user.sample
          ? "This is a demonstration identity, not a customer profile. The role cannot be edited here."
          : "The role shown here is a role already granted to this account. It cannot be edited here."}
      </p>
      <dl className="profile-list">
        <div>
          <dt>Name</dt>
          <dd>{user.name}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{roleLabel(user.role)}</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{user.sample ? "Sample account" : "Signed-in account"}</dd>
        </div>
      </dl>
    </section>
  );
}

function FarmerOverview({ user }: { user: SessionUser }) {
  const data = useCoordination(user);
  const mine = data.phase === "ready" ? listingsForAccount(data.listings, user.id) : [];
  const openCount = mine.filter((listing) => listing.status === "open").length;
  const expected = data.phase === "ready" ? openQuantity(mine, "expected") : null;
  const available = data.phase === "ready" ? openQuantity(mine, "available") : null;
  const agreements = data.phase === "ready" ? commitmentsForSide(data.commitments, data.listings, data.demands, user.id, "listing") : [];
  const confirmedKg = data.phase === "ready" ? confirmedQuantityKg(agreements) : null;
  const purchasedKg = data.phase === "ready" ? purchasedQuantityKg(purchasesForCommitments(data.purchases, agreements)) : null;

  return (
    <>
      {data.phase === "loading" ? <p role="status">Loading your listings…</p> : null}
      {data.phase === "error" ? <p role="alert">{data.message}</p> : null}
      <dl className="stat-grid">
        <div className="stat">
          <dt>Open listings</dt>
          <dd>{data.phase === "ready" ? openCount : "…"}</dd>
          <p>{data.phase !== "ready" ? (user.sample ? "Checking this browser" : "Checking this account") : openCount === 0 ? "None are open" : "Open for coordination"}</p>
        </div>
        <div className="stat">
          <dt>Expected harvest</dt>
          <dd>{data.phase === "ready" ? quantityText(expected) : "…"}</dd>
          <p>Not ready to collect</p>
        </div>
        <div className="stat">
          <dt>Available now</dt>
          <dd>{data.phase === "ready" ? quantityText(available) : "…"}</dd>
          <p>Ready to collect</p>
        </div>
        <div className="stat">
          <dt>Confirmed agreements</dt>
          <dd>{data.phase === "ready" ? countText(confirmedCommitmentCount(agreements)) : "…"}</dd>
          <p>Not purchases, and not matches</p>
        </div>
        <div className="stat">
          <dt>Committed quantity</dt>
          <dd>{data.phase === "ready" ? quantityText(confirmedKg) : "…"}</dd>
          <p>Confirmed agreements only</p>
        </div>
        <div className="stat">
          <dt>Purchased quantity</dt>
          <dd>{data.phase === "ready" ? quantityText(purchasedKg) : "…"}</dd>
          <p>{data.phase !== "ready" ? (user.sample ? "Checking this browser" : "Checking this account") : purchasedKg === null ? "None recorded" : "Each purchase counted once"}</p>
        </div>
      </dl>
      {data.phase === "ready" && mine.length === 0 ? (
        <EmptyState title="You haven't listed any produce yet." body="Start by adding your expected harvest." />
      ) : null}
      <p>
        <a className="btn btn-lime" href="#farmer-listing">
          Add produce
        </a>
      </p>
      <p>
        <a href="#farmer-exposure">Review exposure for your listings</a>
      </p>
      <p>
        <a href="#farmer-outcomes">Record what happened to your produce</a>
      </p>
    </>
  );
}

function countText(count: number): string {
  return count === 0 ? "None" : String(count);
}

function FarmerOpportunities({ user }: { user: SessionUser }) {
  const data = useCoordination(user);
  if (data.phase === "loading") return <p role="status">Loading purchasing requirements…</p>;
  if (data.phase === "error") return <p role="alert">{data.message}</p>;
  const open = data.demands.filter((demand) => demand.status === "open");
  if (open.length === 0) return <EmptyState {...EMPTY.farmerOpportunities} />;
  return (
    <section className="panel">
      <h3>Recorded requirements</h3>
      <p className="setup-note">
        {user.sample
          ? "These are purchasing requirements saved in this browser. They are not confirmed orders."
          : "These are open purchasing requirements. They are not confirmed orders."}
      </p>
      <ul className="record-list">
        {open.map((demand) => (
          <li key={demand.id}>
            <h4>{demand.commodity}</h4>
            <p>
              {quantityText(demand.requestedQuantity)} · {demand.preferredLocation} · {demand.collectionWindow} ·{" "}
              {priceText(demand.indicativePriceKshPerKg)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
