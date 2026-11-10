import type { WorkspaceSection } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { confirmedCommitmentCount, confirmedQuantityKg, purchasedQuantityKg } from "../../lib/coordinationActivity";
import { PUBLISHED_PARTY } from "../../lib/accountCoordination";
import { SAMPLE_USERS, roleLabel } from "../../lib/sampleUsers";
import { EMPTY } from "../../lib/workspaceContent";
import { EmptyState } from "../EmptyState";
import { AgreementDesk } from "../coordination/AgreementDesk";
import { OutcomeDesk } from "../coordination/OutcomeDesk";
import { SurplusDesk } from "../coordination/SurplusDesk";
import { priceText, quantityText, useCoordination } from "../coordination/useCoordination";

export function AdminWorkspace({ user, section }: { user: SessionUser; section: WorkspaceSection }) {
  const data = useCoordination(user);
  if (section.id === "admin-overview") {
    const listingCount = data.phase === "ready" ? data.listings.length : null;
    const demandCount = data.phase === "ready" ? data.demands.length : null;
    const confirmed = data.phase === "ready" ? confirmedCommitmentCount(data.commitments) : null;
    const committedKg = data.phase === "ready" ? confirmedQuantityKg(data.commitments) : null;
    const purchasedKg = data.phase === "ready" ? purchasedQuantityKg(data.purchases) : null;
    return (
      <>
        {data.phase === "error" ? <p role="alert">{data.message}</p> : null}
        <dl className="stat-grid">
          {user.sample ? (
            <div className="stat">
              <dt>Sample accounts</dt>
              <dd>{SAMPLE_USERS.length}</dd>
              <p>Demonstration identities, not customers</p>
            </div>
          ) : (
            <div className="stat">
              <dt>Other accounts</dt>
              <dd>Not included</dd>
              <p>Private records from other accounts are not shown.</p>
            </div>
          )}
          <div className="stat">
            <dt>Listings</dt>
            <dd>{listingCount === null ? "…" : listingCount === 0 ? "None" : listingCount}</dd>
            <p>{data.phase !== "ready" ? place(user.sample) : listingCount === 0 ? "None recorded" : user.sample ? "Saved in this browser" : "Saved for this account"}</p>
          </div>
          <div className="stat">
            <dt>Buyer demand</dt>
            <dd>{demandCount === null ? "…" : demandCount === 0 ? "None" : demandCount}</dd>
            <p>{data.phase !== "ready" ? place(user.sample) : demandCount === 0 ? "None recorded" : user.sample ? "Saved in this browser" : "Saved for this account"}</p>
          </div>
          <div className="stat">
            <dt>Confirmed agreements</dt>
            <dd>{confirmed === null ? "…" : confirmed === 0 ? "None" : confirmed}</dd>
            <p>{data.phase !== "ready" ? place(user.sample) : committedKg === null ? "None recorded" : `${quantityText(committedKg)} agreed, not sold`}</p>
          </div>
          <div className="stat">
            <dt>Recorded purchases</dt>
            <dd>{data.phase !== "ready" ? "…" : purchasedKg === null ? "None" : data.purchases.length}</dd>
            <p>{data.phase !== "ready" ? place(user.sample) : purchasedKg === null ? "None recorded" : `${quantityText(purchasedKg)} bought`}</p>
          </div>
        </dl>
        {user.sample ? (
        <section className="panel" aria-labelledby="sample-accounts-title">
          <h3 id="sample-accounts-title">Sample accounts</h3>
          <p className="setup-note">These demonstration identities are not registered customers.</p>
          <ul className="record-list">
            {SAMPLE_USERS.map((account) => (
              <li key={account.id}>
                <h4>{account.name}</h4>
                <p>
                  <span className="pill pill-ok">Sample {roleLabel(account.role)}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
        ) : (
          <p className="setup-note">An administrator role does not open another account's agreements, purchases, or outcomes.</p>
        )}
        <p>
          <a href="#admin-exposure">{user.sample ? "Review exposure in this browser" : "Review exposure for this account"}</a>
          {" · "}
          <a href="#admin-outcomes">{user.sample ? "Review outcomes in this browser" : "Review outcomes for this account"}</a>
        </p>
        {data.phase === "ready" && data.listings.length === 0 && data.demands.length === 0 && data.commitments.length === 0 && data.purchases.length === 0 ? (
          <EmptyState {...EMPTY.adminActivity} />
        ) : null}
      </>
    );
  }

  if (section.id === "admin-users") {
    if (!user.sample) {
      return (
        <section className="panel" aria-labelledby="users-title">
          <h3 id="users-title">Accounts</h3>
          <p className="setup-note">
            This page does not list other accounts. An administrator role does not open their listings, agreements,
            purchases, or outcomes.
          </p>
        </section>
      );
    }
    return (
      <section className="panel" aria-labelledby="users-title">
        <h3 id="users-title">Sample accounts</h3>
        <p className="setup-note">
          These four accounts are built into the demonstration. They are not registered customers, and this page cannot
          create or edit them.
        </p>
        <ul className="record-list">
          {SAMPLE_USERS.map((account) => (
            <li key={account.id}>
              <h4>{account.name}</h4>
              <p>{account.email}</p>
              <p>
                <span className="pill pill-ok">Sample {roleLabel(account.role)}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (section.id === "admin-listings") {
    if (data.phase === "loading") return <p role="status">Loading listings…</p>;
    if (data.phase === "error") return <p role="alert">{data.message}</p>;
    if (data.listings.length === 0) return <EmptyState {...EMPTY.adminListings} />;
    return (
      <ul className="record-list">
        {data.listings.map((listing) => (
          <li key={listing.id}>
            <h3>
              {listing.commodity} <span className="pill pill-ok">{listing.status}</span>
            </h3>
            <p>
              {quantityText(listing.quantity)} · {listing.quantityKind === "expected" ? "Expected harvest" : "Available now"} ·{" "}
              {listing.location} · {priceText(listing.askingPriceKshPerKg)}
            </p>
            <p>{ownerSentence(listing.ownerId, "listing", user.sample)}</p>
          </li>
        ))}
      </ul>
    );
  }
  if (section.id === "admin-demand") {
    if (data.phase === "loading") return <p role="status">Loading requirements…</p>;
    if (data.phase === "error") return <p role="alert">{data.message}</p>;
    if (data.demands.length === 0) return <EmptyState {...EMPTY.adminDemand} />;
    return (
      <ul className="record-list">
        {data.demands.map((demand) => (
          <li key={demand.id}>
            <h3>
              {demand.commodity} <span className="pill pill-ok">{demand.status}</span>
            </h3>
            <p>
              {quantityText(demand.requestedQuantity)} · {demand.preferredLocation} · {priceText(demand.indicativePriceKshPerKg)}
            </p>
            <p>{ownerSentence(demand.buyerId, "requirement", user.sample)}</p>
          </li>
        ))}
      </ul>
    );
  }
  if (section.id === "admin-matches") return <EmptyState {...EMPTY.adminMatches} />;
  if (section.id === "admin-exposure") return <SurplusDesk user={user} audience="administrator" />;
  if (section.id === "admin-outcomes") return <OutcomeDesk user={user} mode="oversight" />;
  if (section.id === "admin-transactions") {
    return (
      <AgreementDesk
        user={user}
        mode="oversight"
        side="all"
        listHash="#admin-transactions"
        formHash="#admin-transactions"
        purchaseHash="#admin-transactions"
        recordId={null}
      />
    );
  }
  if (data.phase === "loading") return <p role="status">Loading activity…</p>;
  if (data.phase === "error") return <p role="alert">{data.message}</p>;
  if (data.listings.length === 0 && data.demands.length === 0 && data.commitments.length === 0 && data.purchases.length === 0) {
    return <EmptyState {...EMPTY.adminActivity} />;
  }
  return (
    <section className="panel">
      <h3>Recorded activity</h3>
      <p className="setup-note">
        Agreements and purchases are listed under Transactions. This page does not send alerts. An agreement is not a sale.
      </p>
      <p>
        <a href="#admin-transactions">View transactions</a>
      </p>
    </section>
  );
}

function place(sample: boolean): string {
  return sample ? "Checking this browser" : "Checking this account";
}

function ownerSentence(id: string, kind: "listing" | "requirement", sample: boolean): string {
  if (id === PUBLISHED_PARTY) {
    return kind === "listing"
      ? "Published listing. The owner is not shown."
      : "Published requirement. The buyer is not shown.";
  }
  if (!sample) return "Your account. View only.";
  const known = SAMPLE_USERS.find((account) => account.id === id)?.name ?? id;
  return `Sample account ${known}. View only.`;
}
