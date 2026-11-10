import { useContext, useEffect, useRef, useState } from "react";
import type { BuyerDemand, Commitment, CommitmentStatus, Listing, Purchase } from "../../domain/records";
import { loadWorkspaceRecords, participantLabel, saveAccountAgreement, saveAccountPurchase, updateAccountAgreementStatus } from "../../lib/accountCoordination";
import { useRequestGuard } from "../../lib/requestGuard";
import { browserCoordinationRepository } from "../../lib/coordinationClient";
import {
  agreementBlock,
  commitmentsForSide,
  purchasesForCommitments,
  remainingCommitmentKg,
  remainingDemandKg,
  remainingListingKg,
} from "../../lib/coordinationActivity";
import {
  EMPTY_COMMITMENT_FORM,
  EMPTY_PURCHASE_FORM,
  fieldForCommitmentMessage,
  fieldForPurchaseMessage,
  type CommitmentFormValues,
  type PurchaseFormValues,
} from "../../lib/coordinationForms";
import {
  cancelCommitmentRecord,
  confirmProposedCommitment,
  recordConfirmedCommitment,
  recordPurchaseRecord,
} from "../../lib/coordinationWorkflow";
import type { SessionUser } from "../../lib/auth";
import { EMPTY } from "../../lib/workspaceContent";
import { EmptyState } from "../EmptyState";
import { CoordinationAccessContext, CoordinationAlert, reportAccessCode } from "./coordinationAccess";
import { priceText, quantityText } from "./useCoordination";

type Mode = "list" | "form" | "purchase" | "purchases" | "oversight";
type Side = "listing" | "demand" | "all";

interface ReadyRecords {
  listings: readonly Listing[];
  demands: readonly BuyerDemand[];
  commitments: readonly Commitment[];
  purchases: readonly Purchase[];
}

const STORAGE_MESSAGE = "This browser blocked local storage, so saved agreements could not be read.";

const STATUS_NOTE: Record<CommitmentStatus, string> = {
  proposed: "Proposed. This is not an agreed allocation until it is confirmed.",
  confirmed: "Confirmed agreement. This is not a purchase.",
  fulfilled: "Fulfilled. Purchases stay recorded separately.",
  cancelled: "Cancelled. This quantity is not allocated.",
};

export function AgreementDesk({
  user,
  mode,
  side,
  listHash,
  formHash,
  purchaseHash,
  recordId,
}: {
  user: SessionUser;
  mode: Mode;
  side: Side;
  listHash: string;
  formHash: string;
  purchaseHash: string;
  recordId: string | null;
}) {
  const [records, setRecords] = useState<ReadyRecords | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const [confirmingProposed, setConfirmingProposed] = useState<string | null>(null);
  const [commitmentValues, setCommitmentValues] = useState<CommitmentFormValues>(EMPTY_COMMITMENT_FORM);
  const [purchaseValues, setPurchaseValues] = useState<PurchaseFormValues>(EMPTY_PURCHASE_FORM);
  const [agreed, setAgreed] = useState(false);
  const access = useContext(CoordinationAccessContext);
  const accessRef = useRef(access);
  accessRef.current = access;
  const token = access?.token ?? "";
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${user.id}:${user.sample}:${token}:${attempt}:${mode}:${recordId ?? ""}`);

  useEffect(() => {
    const ticket = guard.issue();
    setRecords(null);
    setLoadError(null);
    setError(null);
    setNotice(null);
    const current = accessRef.current;
    const load = user.sample
      ? loadRecords()
      : loadWorkspaceRecords({
          user,
          token: current?.token ?? null,
          api: current?.api ?? null,
          sampleRepository: null,
        });
    void load.then((result) => {
      if (!guard.accept(ticket)) return;
      if (!result.ok) {
        setRecords(null);
        setLoadError(result.message);
        reportAccessCode(accessRef.current, result.code);
        return;
      }
      setRecords(result.records);
    });
  }, [user, guard, mode, recordId, token, attempt]);

  useEffect(() => {
    setNotice(null);
    setError(null);
  }, [mode, recordId]);

  const writable = side !== "all";
  const mine = records
    ? side === "all"
      ? [...records.commitments]
      : commitmentsForSide(records.commitments, records.listings, records.demands, user.id, side)
    : [];
  const minePurchases = records ? purchasesForCommitments(records.purchases, mine) : [];
  const errorField = error
    ? mode === "purchase"
      ? fieldForPurchaseMessage(error)
      : fieldForCommitmentMessage(error)
    : null;

  async function refresh(message: string | null) {
    const ticket = guard.issue();
    const result = user.sample
      ? await loadRecords()
      : await loadWorkspaceRecords({
          user,
          token: access?.token ?? null,
          api: access?.api ?? null,
          sampleRepository: null,
        });
    if (!guard.accept(ticket)) return;
    if (!result.ok) {
      setRecords(null);
      setError(result.message);
      reportAccessCode(access, result.code);
      return;
    }
    setRecords(result.records);
    setError(null);
    setNotice(message);
    setConfirmingCancel(null);
    setConfirmingProposed(null);
  }

  async function saveAgreement() {
    if (!agreed) {
      setError("Confirm that this agreement has been reached before saving.");
      setNotice(null);
      return;
    }
    if (!user.sample) {
      const listing = records?.listings.find((item) => item.id === commitmentValues.listingId) ?? null;
      const demand = records?.demands.find((item) => item.id === commitmentValues.buyerDemandId) ?? null;
      if (listing && demand) {
        const blocked = agreementBlock(listing, demand);
        if (blocked) {
          setError(blocked);
          setNotice(null);
          return;
        }
      }
      const ticket = guard.issue();
      setBusy(true);
      const saved = await saveAccountAgreement({
        user,
        token: access?.token ?? null,
        api: access?.api ?? null,
        values: commitmentValues,
      });
      if (!guard.accept(ticket)) return;
      setBusy(false);
      if (!saved.ok) {
        setError(saved.message);
        setNotice(null);
        reportAccessCode(access, saved.code);
        return;
      }
      setAgreed(false);
      await refresh("Agreement recorded. This is not a purchase.");
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError(STORAGE_MESSAGE);
      return;
    }
    setBusy(true);
    const result = await recordConfirmedCommitment(repository, user, commitmentValues);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setNotice(null);
      return;
    }
    setAgreed(false);
    await refresh("Agreement recorded. This is not a purchase.");
  }

  async function savePurchase(commitmentId: string) {
    if (!user.sample) {
      const ticket = guard.issue();
      setBusy(true);
      const saved = await saveAccountPurchase({
        user,
        token: access?.token ?? null,
        api: access?.api ?? null,
        commitmentId,
        values: purchaseValues,
      });
      if (!guard.accept(ticket)) return;
      setBusy(false);
      if (!saved.ok) {
        setError(saved.message);
        setNotice(null);
        reportAccessCode(access, saved.code);
        return;
      }
      await refresh("Purchase recorded. The agreement is still separate from this purchase.");
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError(STORAGE_MESSAGE);
      return;
    }
    setBusy(true);
    const result = await recordPurchaseRecord(repository, user, commitmentId, purchaseValues);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setNotice(null);
      return;
    }
    await refresh("Purchase recorded. The agreement is still separate from this purchase.");
  }

  async function cancel(id: string) {
    if (!user.sample) {
      await changeStatus(id, "cancelled", "Agreement cancelled. The listing and requirement were not changed.");
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError(STORAGE_MESSAGE);
      return;
    }
    setBusy(true);
    const result = await cancelCommitmentRecord(repository, user, id);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh("Agreement cancelled. The listing and requirement were not changed.");
  }

  async function changeStatus(id: string, status: "confirmed" | "cancelled", message: string) {
    const ticket = guard.issue();
    setBusy(true);
    const saved = await updateAccountAgreementStatus({
      user,
      token: access?.token ?? null,
      api: access?.api ?? null,
      id,
      status,
    });
    if (!guard.accept(ticket)) return;
    setBusy(false);
    if (!saved.ok) {
      setError(saved.message);
      reportAccessCode(access, saved.code);
      return;
    }
    await refresh(message);
  }

  async function confirmProposed(id: string) {
    if (!user.sample) {
      await changeStatus(id, "confirmed", "Agreement confirmed. This is not a purchase.");
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError(STORAGE_MESSAGE);
      return;
    }
    setBusy(true);
    const result = await confirmProposedCommitment(repository, user, id);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh("Agreement confirmed. This is not a purchase.");
  }

  if (mode === "form") {
    return (
      <AgreementForm
        user={user}
        side={side}
        records={records}
        loadError={loadError}
        values={commitmentValues}
        setValues={setCommitmentValues}
        agreed={agreed}
        setAgreed={setAgreed}
        busy={busy}
        error={error}
        errorField={errorField}
        notice={notice}
        listHash={listHash}
        onSave={() => void saveAgreement()}
      />
    );
  }

  if (mode === "purchase") {
    return (
      <PurchaseForm
        user={user}
        side={side}
        records={records}
        loadError={loadError}
        recordId={recordId}
        values={purchaseValues}
        setValues={setPurchaseValues}
        busy={busy}
        error={error}
        errorField={errorField}
        notice={notice}
        listHash={listHash}
        onSave={(id) => void savePurchase(id)}
      />
    );
  }

  return (
    <div className="record-desk">
      {writable && mode !== "purchases" ? (
        <p>
          <a className="btn btn-lime" href={formHash}>
            Record an agreement
          </a>
        </p>
      ) : null}
      {mode === "oversight" ? (
        <p className="setup-note">
          {user.sample
            ? "View only. These records are saved in this browser. An agreement is not a completed sale."
            : "View only. These are agreements this account participates in. An agreement is not a completed sale."}
        </p>
      ) : null}
      {loadError ? <CoordinationAlert message={loadError} /> : null}
      {!records && !loadError ? <p role="status">Loading agreements…</p> : null}
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      {records && mode !== "purchases" && mine.length === 0 ? (
        <EmptyState
          title={side === "all" ? EMPTY.adminTransactions.title : side === "demand" ? EMPTY.buyerCommitments.title : "No agreements yet."}
          body={
            side === "all"
              ? EMPTY.adminTransactions.body
              : side === "demand"
                ? EMPTY.buyerCommitments.body
                : "An agreement is recorded when you confirm a quantity and price. A match is not an agreement."
          }
        />
      ) : null}
      {records && mode !== "purchases" && mine.length > 0 ? (
        <ul className="record-list">
          {mine.map((commitment) => {
            const listing = records.listings.find((item) => item.id === commitment.listingId);
            const demand = records.demands.find((item) => item.id === commitment.buyerDemandId);
            const purchases = records.purchases.filter((item) => item.commitmentId === commitment.id);
            const left = remainingCommitmentKg(commitment, records.purchases);
            const canCancel =
              writable &&
              (commitment.status === "proposed" || commitment.status === "confirmed") &&
              purchases.length === 0;
            return (
              <li key={commitment.id}>
                <h3>
                  {listing?.commodity ?? "Produce"} <span className={commitment.status === "cancelled" || commitment.status === "proposed" ? "pill pill-out" : "pill pill-ok"}>{commitment.status}</span>
                </h3>
                <p>
                  Agreed {quantityText(commitment.agreedQuantity)} at {priceText(commitment.agreedPriceKshPerKg)}.
                </p>
                <p>{STATUS_NOTE[commitment.status]}</p>
                <p>
                  {listing ? `${listing.location} · ${listing.availabilityWindow}` : "Listing"} ·{" "}
                  {listing?.quantityKind === "expected" ? "Expected harvest, not ready to collect." : "Available now."} Expected collection{" "}
                  {commitment.expectedFulfilmentDate}.
                </p>
                <p>
                  {participantLabel(user, listing?.ownerId, "listing")} listing · {participantLabel(user, demand?.buyerId, "requirement")} requirement · {demand?.collectionWindow}.
                </p>
                <p>Purchased {purchases.length === 0 ? "None" : quantityText(purchases.reduce((total, item) => total + item.actualQuantity, 0))}. Remaining on this agreement: {commitment.status === "confirmed" ? quantityText(left) : "None"}.</p>
                {writable && commitment.status === "proposed" ? (
                  confirmingProposed === commitment.id ? (
                    <div className="confirm-panel">
                      <h3>Confirm this agreement?</h3>
                      <p>This records that the quantity and price have been agreed. It does not record a purchase.</p>
                      <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void confirmProposed(commitment.id)}>
                        Confirm agreement
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmingProposed(null)}>
                        Keep it as it is
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmingProposed(commitment.id)}>
                      Confirm agreement
                    </button>
                  )
                ) : null}
                {writable && commitment.status === "confirmed" && left > 0 ? (
                  <p>
                    <a href={`${purchaseHash}?id=${commitment.id}`}>Record a purchase</a>
                  </p>
                ) : null}
                {canCancel ? (
                  confirmingCancel === commitment.id ? (
                    <div className="confirm-panel">
                      <h3>Cancel this agreement?</h3>
                      <p>The quantity will no longer be allocated. The listing and requirement stay as they are.</p>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void cancel(commitment.id)}>
                        Cancel agreement
                      </button>
                      <button type="button" className="btn btn-lime" disabled={busy} onClick={() => setConfirmingCancel(null)}>
                        Keep it as it is
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmingCancel(commitment.id)}>
                      Cancel agreement
                    </button>
                  )
                ) : null}
                {writable && purchases.length > 0 && (commitment.status === "confirmed" || commitment.status === "proposed") ? (
                  <p>This agreement has a purchase, so it cannot be cancelled.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {records && (mode === "list" || mode === "purchases" || mode === "oversight") ? (
        <section className="panel" aria-labelledby="purchase-list-title">
          <h3 id="purchase-list-title">Purchases</h3>
          <p className="setup-note">A purchase is what was actually bought. It is recorded separately from the agreement.</p>
          {shownPurchases(mode, minePurchases, records.purchases).length === 0 ? (
            <EmptyState
              title={EMPTY.buyerPurchases.title}
              body={mode === "oversight" ? "Purchases will appear here when they exist." : EMPTY.buyerPurchases.body}
            />
          ) : (
            <ul className="record-list">
              {shownPurchases(mode, minePurchases, records.purchases).map((purchase) => {
                const agreement = records.commitments.find((item) => item.id === purchase.commitmentId);
                const listing = records.listings.find((item) => item.id === purchase.listingId);
                return (
                <li key={purchase.id}>
                  <h4>{listing?.commodity ?? "Produce"} · {quantityText(purchase.actualQuantity)}</h4>
                  <p>
                    {priceText(purchase.actualPriceKshPerKg)} · {purchase.purchaseDate}
                    {agreement ? ` · Agreement ${agreement.status}` : " · Agreement unavailable"}
                    {mode === "oversight" ? " · View only." : ""}
                  </p>
                </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function AgreementForm({
  user,
  side,
  records,
  loadError,
  values,
  setValues,
  agreed,
  setAgreed,
  busy,
  error,
  errorField,
  notice,
  listHash,
  onSave,
}: {
  user: SessionUser;
  side: Side;
  records: ReadyRecords | null;
  loadError: string | null;
  values: CommitmentFormValues;
  setValues: (update: (current: CommitmentFormValues) => CommitmentFormValues) => void;
  agreed: boolean;
  setAgreed: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  errorField: string | null;
  notice: string | null;
  listHash: string;
  onSave: () => void;
}) {
  const listings = records
    ? side === "demand"
      ? records.listings.filter((listing) => listing.status === "open")
      : records.listings.filter((listing) => listing.ownerId === user.id && listing.status === "open")
    : [];
  const demands = records
    ? side === "listing"
      ? records.demands.filter((demand) => demand.status === "open")
      : records.demands.filter((demand) => demand.buyerId === user.id && demand.status === "open")
    : [];
  const listing = listings.find((item) => item.id === values.listingId) ?? null;
  const demand = demands.find((item) => item.id === values.buyerDemandId) ?? null;
  const otherDemands = listing ? demands.filter((item) => agreementBlock(listing, item) === null) : demands;
  const otherListings = demand ? listings.filter((item) => agreementBlock(item, demand) === null) : listings;
  const listingChoices = side === "demand" ? otherListings : listings;
  const demandChoices = side === "listing" ? otherDemands : demands;
  const blocked = listing && demand ? agreementBlock(listing, demand) : null;
  const listingLeft = records && listing ? remainingListingKg(listing, records.commitments, records.purchases) : null;
  const demandLeft = records && demand ? remainingDemandKg(demand, records.commitments, records.purchases) : null;

  return (
    <form className="panel record-form" data-form="commitment" onSubmit={(event) => event.preventDefault()} noValidate>
      <p className="setup-note">
        Required fields are marked. This saves an agreed quantity and price. It does not record a purchase.
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {!records && !loadError ? <p role="status">Loading listings and requirements…</p> : null}
      <div className="form-stack">
        <div className="field">
          <label htmlFor="commitment-listing">
            Listing <span className="req">Required</span>
          </label>
          <select
            id="commitment-listing"
            value={values.listingId}
            aria-required="true"
            aria-invalid={errorField === "listingId" ? true : undefined}
            disabled={busy || !records}
            onChange={(event) => {
              const listingId = event.target.value;
              setValues((current) => ({ ...current, listingId }));
            }}
          >
            <option value="">Choose a listing</option>
            {listingChoices.map((item) => (
              <option key={item.id} value={item.id}>
                {optionLabel(item)}
              </option>
            ))}
          </select>
          {listing?.quantityKind === "expected" ? (
            <p className="setup-note">This is an expected harvest. It is not produce that is ready to collect.</p>
          ) : null}
          <FieldIssue active={errorField === "listingId"} message={error} />
        </div>
        <div className="field">
          <label htmlFor="commitment-demand">
            Purchasing requirement <span className="req">Required</span>
          </label>
          <select
            id="commitment-demand"
            value={values.buyerDemandId}
            aria-required="true"
            aria-invalid={errorField === "buyerDemandId" ? true : undefined}
            disabled={busy || !records}
            onChange={(event) => {
              const buyerDemandId = event.target.value;
              setValues((current) => ({ ...current, buyerDemandId }));
            }}
          >
            <option value="">Choose a requirement</option>
            {demandChoices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.commodity} · {quantityText(item.requestedQuantity)} · {item.preferredLocation} · {item.collectionWindow}
              </option>
            ))}
          </select>
          {records && side === "listing" && listing && demandChoices.length === 0 ? (
            <p className="setup-note">No open requirement fits this listing's produce and collection window.</p>
          ) : null}
          {records && side === "demand" && demand && listingChoices.length === 0 ? (
            <p className="setup-note">No open listing fits this requirement's produce and collection window.</p>
          ) : null}
          <FieldIssue active={errorField === "buyerDemandId"} message={error} />
        </div>
        {blocked ? <p role="status">{blocked}</p> : null}
        {listingLeft !== null && demandLeft !== null && !blocked ? (
          <p className="setup-note">
            {quantityText(listingLeft)} can still be agreed on this listing. {quantityText(demandLeft)} can still be agreed on this
            requirement. You can agree up to {quantityText(Math.min(listingLeft, demandLeft))}.
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="commitment-quantity">
            Agreed quantity (kg) <span className="req">Required</span>
          </label>
          <input
            id="commitment-quantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder="300"
            aria-required="true"
            aria-invalid={errorField === "quantity" ? true : undefined}
            aria-describedby="commitment-quantity-help"
            disabled={busy}
            value={values.quantity}
            onChange={(event) => setValues((current) => ({ ...current, quantity: event.target.value }))}
          />
          <p id="commitment-quantity-help" className="setup-note">
            For example, 300. Use kilograms, up to 3 decimal places.
          </p>
          <FieldIssue active={errorField === "quantity"} message={error} />
        </div>
        <div className="field">
          <label htmlFor="commitment-price">
            Agreed price (KSh/kg) <span className="req">Required</span>
          </label>
          <input
            id="commitment-price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40"
            aria-required="true"
            aria-invalid={errorField === "price" ? true : undefined}
            aria-describedby="commitment-price-help"
            disabled={busy}
            value={values.price}
            onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))}
          />
          <p id="commitment-price-help" className="setup-note">
            For example, 40. This is the agreed price, not a payment.
          </p>
          <FieldIssue active={errorField === "price"} message={error} />
        </div>
        <div className="field">
          <label htmlFor="commitment-date">
            Expected collection date <span className="req">Required</span>
          </label>
          <input
            id="commitment-date"
            type="date"
            aria-required="true"
            aria-invalid={errorField === "expectedFulfilmentDate" ? true : undefined}
            aria-describedby="commitment-date-help"
            disabled={busy}
            value={values.expectedFulfilmentDate}
            onChange={(event) => setValues((current) => ({ ...current, expectedFulfilmentDate: event.target.value }))}
          />
          <p id="commitment-date-help" className="setup-note">
            The day you expect collection. The time of the agreement is saved when you record it.
          </p>
          <FieldIssue active={errorField === "expectedFulfilmentDate"} message={error} />
        </div>
        <label className="mode-option">
          <input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} />
          We have agreed this quantity and price.
        </label>
      </div>
      {error && !errorField ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      {busy ? <p role="status">Saving…</p> : null}
      <div className="scenario-controls">
        <button type="button" className="btn btn-lime" disabled={busy} onClick={onSave}>
          Record agreement
        </button>
        <a className="btn btn-secondary" href={listHash}>
          Cancel
        </a>
      </div>
    </form>
  );
}

function PurchaseForm({
  user,
  side,
  records,
  loadError,
  recordId,
  values,
  setValues,
  busy,
  error,
  errorField,
  notice,
  listHash,
  onSave,
}: {
  user: SessionUser;
  side: Side;
  records: ReadyRecords | null;
  loadError: string | null;
  recordId: string | null;
  values: PurchaseFormValues;
  setValues: (update: (current: PurchaseFormValues) => PurchaseFormValues) => void;
  busy: boolean;
  error: string | null;
  errorField: string | null;
  notice: string | null;
  listHash: string;
  onSave: (commitmentId: string) => void;
}) {
  const commitment = records?.commitments.find((item) => item.id === recordId) ?? null;
  const listing = commitment ? records?.listings.find((item) => item.id === commitment.listingId) : null;
  const demand = commitment ? records?.demands.find((item) => item.id === commitment.buyerDemandId) : null;
  const involved = user.sample
    ? !commitment || (side === "listing" ? listing?.ownerId === user.id : side === "demand" ? demand?.buyerId === user.id : false)
    : commitment !== null;
  const left = commitment && records ? remainingCommitmentKg(commitment, records.purchases) : null;
  return (
    <form className="panel record-form" data-form="purchase" onSubmit={(event) => event.preventDefault()} noValidate>
      <p className="setup-note">Required fields are marked. This records what was bought. It does not change the agreement.</p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {!records && !loadError ? <p role="status">Loading the agreement…</p> : null}
      {records && !commitment ? (
        <p role="alert">{!user.sample && recordId ? "That record could not be found." : "Choose an agreement that is already saved."}</p>
      ) : null}
      {records && commitment && !involved ? (
        <p role="alert">{user.sample ? "This agreement does not involve your sample account." : "That record could not be found."}</p>
      ) : null}
      {commitment && involved && left !== null ? (
        <p className="setup-note">
          Agreed {quantityText(commitment.agreedQuantity)} at {priceText(commitment.agreedPriceKshPerKg)}.{" "}
          {quantityText(left)} can still be purchased. The agreement status is {commitment.status}.
        </p>
      ) : null}
      <div className="form-stack">
        <div className="field">
          <label htmlFor="purchase-quantity">
            Purchased quantity (kg) <span className="req">Required</span>
          </label>
          <input
            id="purchase-quantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder="100"
            aria-required="true"
            aria-invalid={errorField === "quantity" ? true : undefined}
            aria-describedby="purchase-quantity-help"
            disabled={busy || !commitment || !involved}
            value={values.quantity}
            onChange={(event) => setValues((current) => ({ ...current, quantity: event.target.value }))}
          />
          <p id="purchase-quantity-help" className="setup-note">
            For example, 100. This cannot be more than the quantity still left on the agreement.
          </p>
          <FieldIssue active={errorField === "quantity"} message={error} />
        </div>
        <div className="field">
          <label htmlFor="purchase-price">
            Price paid (KSh/kg) <span className="req">Required</span>
          </label>
          <input
            id="purchase-price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40"
            aria-required="true"
            aria-invalid={errorField === "price" ? true : undefined}
            disabled={busy || !commitment || !involved}
            value={values.price}
            onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))}
          />
          <FieldIssue active={errorField === "price"} message={error} />
        </div>
        <div className="field">
          <label htmlFor="purchase-date">
            Purchase date <span className="req">Required</span>
          </label>
          <input
            id="purchase-date"
            type="date"
            aria-required="true"
            aria-invalid={errorField === "purchaseDate" ? true : undefined}
            disabled={busy || !commitment || !involved}
            value={values.purchaseDate}
            onChange={(event) => setValues((current) => ({ ...current, purchaseDate: event.target.value }))}
          />
          <FieldIssue active={errorField === "purchaseDate"} message={error} />
        </div>
      </div>
      {error && !errorField ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      {busy ? <p role="status">Saving…</p> : null}
      <div className="scenario-controls">
        <button
          type="button"
          className="btn btn-lime"
          disabled={busy || !commitment || !involved}
          onClick={() => commitment && involved && onSave(commitment.id)}
        >
          Record purchase
        </button>
        <a className="btn btn-secondary" href={listHash}>
          Cancel
        </a>
      </div>
    </form>
  );
}

async function loadRecords(): Promise<
  { ok: true; records: ReadyRecords } | { ok: false; code: string; message: string }
> {
  const repository = browserCoordinationRepository();
  if (!repository) return { ok: false, code: "storage", message: STORAGE_MESSAGE };
  const [listings, demands, commitments, purchases] = await Promise.all([
    repository.listListings(),
    repository.listBuyerDemands(),
    repository.listCommitments(),
    repository.listPurchases(),
  ]);
  if (!listings.ok) return { ok: false, code: listings.code, message: listings.message };
  if (!demands.ok) return { ok: false, code: demands.code, message: demands.message };
  if (!commitments.ok) return { ok: false, code: commitments.code, message: commitments.message };
  if (!purchases.ok) return { ok: false, code: purchases.code, message: purchases.message };
  return {
    ok: true,
    records: {
      listings: listings.value,
      demands: demands.value,
      commitments: commitments.value,
      purchases: purchases.value,
    },
  };
}

function shownPurchases(mode: Mode, mine: readonly Purchase[], all: readonly Purchase[]): readonly Purchase[] {
  return mode === "oversight" ? all : mine;
}

function optionLabel(listing: Listing): string {
  const kind = listing.quantityKind === "expected" ? "Expected harvest" : "Available now";
  return `${listing.commodity} · ${quantityText(listing.quantity)} · ${listing.location} · ${listing.availabilityWindow} · ${kind}`;
}

function FieldIssue({ active, message }: { active: boolean; message: string | null }) {
  if (!active || !message) return null;
  return (
    <p role="alert" className="field-error">
      {message}
    </p>
  );
}
