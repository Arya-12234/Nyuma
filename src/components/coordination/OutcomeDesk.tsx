import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../../domain/records";
import { OUTCOME_CATEGORIES } from "../../domain/records";
import { loadWorkspaceRecords, outcomeNoteText, saveAccountOutcome } from "../../lib/accountCoordination";
import { useRequestGuard } from "../../lib/requestGuard";
import type { SessionUser } from "../../lib/auth";
import { browserCoordinationRepository } from "../../lib/coordinationClient";
import {
  EMPTY_OUTCOME_FORM,
  fieldForOutcomeMessage,
  type OutcomeFormValues,
} from "../../lib/coordinationForms";
import { recordOutcomeRecord } from "../../lib/coordinationWorkflow";
import {
  OUTCOME_LABELS,
  listingOutcomeAccount,
  outcomeSummary,
  outcomesForBuyer,
  type OutcomeSummary,
} from "../../lib/outcomeAccounting";
import { EmptyState } from "../EmptyState";
import { CoordinationAccessContext, CoordinationAlert, reportAccessCode } from "./coordinationAccess";
import { quantityText } from "./useCoordination";

type Mode = "record" | "buyer" | "oversight";

interface ReadyRecords {
  listings: readonly Listing[];
  demands: readonly BuyerDemand[];
  commitments: readonly Commitment[];
  purchases: readonly Purchase[];
  outcomes: readonly Outcome[];
}

const STORAGE_MESSAGE = "This browser blocked local storage, so saved produce could not be read.";
const LIMITATION =
  "These figures are what was recorded. A recovered quantity is not proof the produce would otherwise have spoiled. Nyuma does not calculate a percentage reduction in post-harvest loss.";

export function OutcomeDesk({ user, mode }: { user: SessionUser; mode: Mode }) {
  const [records, setRecords] = useState<ReadyRecords | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<OutcomeFormValues>(EMPTY_OUTCOME_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const access = useContext(CoordinationAccessContext);
  const accessRef = useRef(access);
  accessRef.current = access;
  const token = access?.token ?? "";
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${user.id}:${user.sample}:${token}:${attempt}:${reloadKey}`);

  useEffect(() => {
    const ticket = guard.issue();
    setRecords(null);
    setLoadError(null);
    setBusy(false);
    const current = accessRef.current;
    const load = user.sample ? loadSampleOutcomes() : loadWorkspaceRecords({
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
  }, [reloadKey, user, guard, token, attempt]);

  const ownListings = records?.listings.filter((listing) => listing.ownerId === user.id) ?? [];
  const summaryListings = user.sample && mode === "oversight" ? records?.listings ?? [] : ownListings;
  const summary = records ? outcomeSummary(summaryListings, records.outcomes, records.purchases) : null;
  const visibleOutcomes = visibleFor(mode, user.id, records);
  const selectedListing = ownListings.find((listing) => listing.id === values.listingId) ?? null;
  const listingPurchases = records?.purchases.filter((purchase) => purchase.listingId === values.listingId) ?? [];
  const errorField = error ? fieldForOutcomeMessage(error) : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!user.sample) {
      if (!records) {
        setError("Saved listings are still loading.");
        return;
      }
      const purchase = records.purchases.find((item) => item.id === values.purchaseId) ?? null;
      const ticket = guard.issue();
      setBusy(true);
      setError(null);
      setNotice(null);
      const saved = await saveAccountOutcome({
        user,
        token: access?.token ?? null,
        api: access?.api ?? null,
        values,
        purchase: values.saleKind === "purchase" ? purchase : null,
      });
      if (!guard.accept(ticket)) return;
      setBusy(false);
      if (!saved.ok) {
        setError(saved.message);
        reportAccessCode(access, saved.code);
        return;
      }
      setNotice(savedNotice(values.category, values.saleKind));
      setValues((current) => ({ ...EMPTY_OUTCOME_FORM, listingId: current.listingId }));
      setReloadKey((current) => current + 1);
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError(STORAGE_MESSAGE);
      return;
    }
    if (!records) {
      setError("Saved listings are still loading.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const saved = await recordOutcomeRecord(repository, user, values);
    setBusy(false);
    if (!saved.ok) {
      setError(saved.message);
      return;
    }
    setNotice(savedNotice(values.category, values.saleKind));
    setValues((current) => ({ ...EMPTY_OUTCOME_FORM, listingId: current.listingId }));
    setReloadKey((current) => current + 1);
  }

  return (
    <div className="record-desk" data-view="outcomes">
      <p className="setup-note">{intro(mode, user.sample)}</p>
      <p className="setup-note">{LIMITATION}</p>
      {!records && !loadError ? <p role="status">Loading saved listings…</p> : null}
      {loadError ? <CoordinationAlert message={loadError} /> : null}
      {summary && records && mode !== "buyer" ? <Summary summary={summary} mode={mode} sample={user.sample} /> : null}
      {records && visibleOutcomes.length === 0 ? (
        <EmptyState title={emptyTitle(mode, user.sample)} body={emptyBody(mode)} />
      ) : null}
      {records && mode !== "buyer" && summaryListings.length > 0 ? (
        <section className="panel" aria-labelledby="outcome-listings-title">
          <h3 id="outcome-listings-title">{user.sample && mode === "oversight" ? "Listings in this browser" : "Your listings"}</h3>
          <ul className="record-list">
            {summaryListings.map((listing) => {
              const account = listingOutcomeAccount(listing, records.outcomes, records.purchases);
              return (
                <li key={listing.id}>
                  <h4>
                    {listing.commodity}{" "}
                    <span className={listing.quantityKind === "expected" ? "pill pill-out" : "pill pill-ok"}>
                      {listing.quantityKind === "expected" ? "Expected harvest" : "Available now"}
                    </span>
                  </h4>
                  {listing.quantityKind === "expected" ? (
                    <p>Upcoming supply — not ready for collection. An outcome does not make this harvest ready to collect.</p>
                  ) : null}
                  <ul>
                    <li>{quantityText(account.listedKg)} listed.</li>
                    <li>{quantityText(account.soldKg)} recorded as sold.</li>
                    <li>{quantityText(account.recoveredKg)} recovered.</li>
                    <li>{quantityText(account.spoiledKg)} spoiled.</li>
                    <li>{quantityText(account.donatedKg)} donated.</li>
                    <li>{quantityText(account.disposedKg)} disposed of.</li>
                    <li>{quantityText(account.purchasedWithoutSoldOutcomeKg)} purchased, with no sold outcome recorded for that purchase.</li>
                    <li>{quantityText(account.noOutcomeKg)} has no outcome record. A purchase can sit here until a sold outcome is recorded. This is not spoilage.</li>
                    <li>{quantityText(account.unaccountedKg)} still unaccounted for. Unaccounted quantity has no recorded outcome. It does not mean spoiled.</li>
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {records && visibleOutcomes.length > 0 ? (
        <section className="panel" aria-labelledby="outcome-records-title">
          <h3 id="outcome-records-title">Recorded outcomes</h3>
          <ul className="record-list">
            {visibleOutcomes.map((outcome) => {
              const listing = records.listings.find((item) => item.id === outcome.listingId);
              return (
                <li key={outcome.id}>
                  <h4>
                    {listing?.commodity ?? "Produce"} <span className="pill pill-ok">{OUTCOME_LABELS[outcome.category]}</span>
                  </h4>
                  <p>
                    {quantityText(outcome.quantity)} · {outcome.recordedDate}
                  </p>
                  <p>{outcomeSentence(outcome)}</p>
                  <OutcomeNote notes={outcome.notes} buyer={mode === "buyer"} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {mode === "buyer" ? (
        <p>
          <a href="#buyer-purchases">View purchase history</a>
        </p>
      ) : null}
      {mode === "record" ? (
        <form className="record-form form-stack" data-form="outcome" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="outcome-listing">
              Listing <span className="req">Required</span>
            </label>
            <select
              id="outcome-listing"
              value={values.listingId}
              aria-required="true"
              aria-invalid={errorField === "listingId" ? true : undefined}
              disabled={busy || ownListings.length === 0}
              onChange={(event) =>
                setValues((current) => ({ ...current, listingId: event.target.value, purchaseId: "" }))
              }
            >
              <option value="">Choose a listing</option>
              {ownListings.map((listing) => (
                <option key={listing.id} value={listing.id}>
                  {listing.commodity} · {quantityText(listing.quantity)} · {listing.quantityKind === "expected" ? "expected harvest" : "available now"}
                </option>
              ))}
            </select>
            <FieldIssue active={errorField === "listingId"} message={error} />
            {records && ownListings.length === 0 ? (
              <p className="setup-note">
                Add a listing before recording an outcome. <a href={user.role === "trader" ? "#stock-form" : "#farmer-listing"}>Add produce</a>
              </p>
            ) : null}
            {selectedListing?.quantityKind === "expected" ? (
              <p className="setup-note">This listing is an expected harvest. It is not ready for collection, and saving an outcome does not change that.</p>
            ) : null}
          </div>
          <fieldset>
            <legend>
              What happened to this produce? <span className="req">Required</span>
            </legend>
            {OUTCOME_CATEGORIES.map((category) => (
              <label key={category} className="mode-option">
                <input
                  type="radio"
                  name="outcome-category"
                  value={category}
                  checked={values.category === category}
                  disabled={busy}
                  onChange={() => setValues((current) => ({ ...current, category, saleKind: "", purchaseId: "" }))}
                />
                {OUTCOME_LABELS[category]}
              </label>
            ))}
            <FieldIssue active={errorField === "category"} message={error} />
          </fieldset>
          {values.category === "sold" ? (
            <fieldset>
              <legend>
                Which sale is this? <span className="req">Required</span>
              </legend>
              <label className="mode-option">
                <input
                  type="radio"
                  name="outcome-sale-kind"
                  value="purchase"
                  checked={values.saleKind === "purchase"}
                  disabled={busy}
                  onChange={() => setValues((current) => ({ ...current, saleKind: "purchase", purchaseId: "" }))}
                />
                This sale is already saved as a purchase
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="outcome-sale-kind"
                  value="external"
                  checked={values.saleKind === "external"}
                  disabled={busy}
                  onChange={() => setValues((current) => ({ ...current, saleKind: "external", purchaseId: "" }))}
                />
                This sale happened outside Nyuma
              </label>
              <p className="setup-note">
                {values.saleKind === "purchase"
                  ? "This points at a purchase that is already saved. It does not create another sale, and those kilograms are not added again."
                  : values.saleKind === "external"
                    ? "This is a separate sale. It is counted apart from purchases already saved in Nyuma."
                    : "Choose one. A purchase is not copied into an outcome unless you select it."}
              </p>
              <FieldIssue active={errorField === "saleKind"} message={error} />
            </fieldset>
          ) : null}
          {values.category === "sold" && values.saleKind === "purchase" ? (
            <div className="field">
              <label htmlFor="outcome-purchase">
                Saved purchase <span className="req">Required</span>
              </label>
              <select
                id="outcome-purchase"
                value={values.purchaseId}
                aria-required="true"
                aria-invalid={errorField === "purchaseId" ? true : undefined}
                disabled={busy || listingPurchases.length === 0}
                onChange={(event) => setValues((current) => ({ ...current, purchaseId: event.target.value }))}
              >
                <option value="">Choose a purchase</option>
                {listingPurchases.map((purchase) => (
                  <option key={purchase.id} value={purchase.id}>
                    {quantityText(purchase.actualQuantity)} on {purchase.purchaseDate}
                  </option>
                ))}
              </select>
              {values.listingId !== "" && listingPurchases.length === 0 ? (
                <p className="setup-note">
                  No purchase is saved against this listing.{" "}
                  <a href={user.role === "trader" ? "#transactions" : "#farmer-commitments"}>Review agreements</a>
                </p>
              ) : null}
              <FieldIssue active={errorField === "purchaseId"} message={error} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="outcome-quantity">
              Quantity (kg) <span className="req">Required</span>
            </label>
            <input
              id="outcome-quantity"
              inputMode="decimal"
              autoComplete="off"
              aria-required="true"
              aria-invalid={errorField === "quantity" ? true : undefined}
              disabled={busy}
              value={values.quantity}
              onChange={(event) => setValues((current) => ({ ...current, quantity: event.target.value }))}
            />
            <FieldIssue active={errorField === "quantity"} message={error} />
          </div>
          <div className="field">
            <label htmlFor="outcome-date">
              Date this happened <span className="req">Required</span>
            </label>
            <input
              id="outcome-date"
              type="date"
              aria-required="true"
              aria-invalid={errorField === "recordedDate" ? true : undefined}
              disabled={busy}
              value={values.recordedDate}
              onChange={(event) => setValues((current) => ({ ...current, recordedDate: event.target.value }))}
            />
            <FieldIssue active={errorField === "recordedDate"} message={error} />
          </div>
          <div className="field">
            <label htmlFor="outcome-notes">
              Notes <span className="opt">Optional</span>
            </label>
            <textarea
              id="outcome-notes"
              rows={3}
              maxLength={500}
              aria-invalid={errorField === "notes" ? true : undefined}
              disabled={busy}
              value={values.notes}
              onChange={(event) => setValues((current) => ({ ...current, notes: event.target.value }))}
            />
            <FieldIssue active={errorField === "notes"} message={error} />
          </div>
          {error && !errorField ? <p role="alert">{error}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {ownListings.length > 0 ? (
            <button className="btn btn-lime" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save outcome"}
            </button>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function Summary({ summary, mode, sample }: { summary: OutcomeSummary; mode: Mode; sample: boolean }) {
  return (
    <dl className="stat-grid">
      <Stat label="Listed" value={summary.listedKg} note={mode === "oversight" && sample ? "Saved in this browser" : "Your listings"} />
      <Stat label="Sold" value={summary.soldKg} note="Recorded sold outcomes" />
      <Stat label="Recovered" value={summary.recoveredKg} note="A recorded outcome, not proof of loss avoided" />
      <Stat label="Spoiled" value={summary.spoiledKg} note="Recorded spoiled outcomes" />
      <Stat label="Donated" value={summary.donatedKg} note="Recorded donated outcomes" />
      <Stat label="Disposed of" value={summary.disposedKg} note="Recorded disposed outcomes" />
      <Stat label="No outcome record" value={summary.noOutcomeKg} note="Includes purchases that have no sold outcome" />
      <div className="stat">
        <dt>Listings with an outcome</dt>
        <dd>{summary.listingsWithOutcomes === 0 ? "None" : summary.listingsWithOutcomes}</dd>
        <p>{mode === "oversight" && sample ? "Records in this browser" : "Your listings"}</p>
      </div>
    </dl>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{quantityText(value)}</dd>
      <p>{note}</p>
    </div>
  );
}

function loadSampleOutcomes(): Promise<{ ok: true; records: ReadyRecords } | { ok: false; code: string; message: string }> {
  const repository = browserCoordinationRepository();
  if (!repository) return Promise.resolve({ ok: false, code: "storage", message: STORAGE_MESSAGE });
  return Promise.all([
    repository.listListings(),
    repository.listBuyerDemands(),
    repository.listCommitments(),
    repository.listPurchases(),
    repository.listOutcomes(),
  ]).then(([listings, demands, commitments, purchases, outcomes]) => {
    const failed = [listings, demands, commitments, purchases, outcomes].find((result) => !result.ok);
    if (failed && !failed.ok) return { ok: false as const, code: failed.code, message: failed.message };
    if (!listings.ok || !demands.ok || !commitments.ok || !purchases.ok || !outcomes.ok) {
      return { ok: false as const, code: "storage", message: STORAGE_MESSAGE };
    }
    return {
      ok: true as const,
      records: {
        listings: listings.value,
        demands: demands.value,
        commitments: commitments.value,
        purchases: purchases.value,
        outcomes: outcomes.value,
      },
    };
  });
}

export function OutcomeNote({ notes, buyer }: { notes: string | null; buyer: boolean }) {
  if (notes === null) return <p>Notes are not available.</p>;
  if (buyer || notes === "") return null;
  return <p>{outcomeNoteText(notes)}</p>;
}

function visibleFor(mode: Mode, accountId: string, records: ReadyRecords | null): Outcome[] {
  if (!records) return [];
  if (mode === "oversight") return [...records.outcomes];
  if (mode === "buyer") {
    return outcomesForBuyer(accountId, records.outcomes, records.purchases, records.commitments, records.demands);
  }
  const own = new Set(records.listings.filter((listing) => listing.ownerId === accountId).map((listing) => listing.id));
  return records.outcomes.filter((outcome) => own.has(outcome.listingId));
}

function outcomeSentence(outcome: Outcome): string {
  if (outcome.category === "sold" && outcome.purchaseId) {
    return "This sold outcome points at a purchase already saved. Those kilograms are not added again.";
  }
  if (outcome.category === "sold") return "This sale was recorded outside a saved purchase.";
  if (outcome.category === "recovered") {
    return "This is a recorded recovery. It is not proof the produce would otherwise have spoiled.";
  }
  return "This is a recorded outcome. It is not a prediction.";
}

function savedNotice(category: string, saleKind: string): string {
  if (category === "sold" && saleKind === "purchase") {
    return "Outcome saved. This points at the purchase already recorded. Those kilograms were not added again.";
  }
  if (category === "sold" && saleKind === "external") {
    return "Outcome saved. This sale is outside the purchases already recorded in Nyuma.";
  }
  return "Outcome saved. The listing quantity is unchanged, and no purchase was created.";
}

function intro(mode: Mode, sample: boolean): string {
  if (mode === "oversight") {
    return sample
      ? "These are records saved in this browser. They are not county, national, or platform-wide totals. This page is view only."
      : "These are records this account can see. They are not county, national, or platform-wide totals. This page is view only.";
  }
  if (mode === "buyer") {
    return "Purchase history is separate. This page only shows a sold outcome when it points at one of your purchases. Notes and other listings are not shown. You cannot record spoilage or disposal here.";
  }
  return "Record what happened to your own produce. Nyuma does not infer an outcome from an agreement or a purchase.";
}

function emptyTitle(mode: Mode, sample: boolean): string {
  if (mode === "buyer") return "No sold outcome is linked to your purchases.";
  if (mode === "oversight") return sample ? "No outcomes recorded in this browser." : "No outcomes are available for this account.";
  return "No outcomes recorded yet.";
}

function emptyBody(mode: Mode): string {
  if (mode === "buyer") return "A purchase stays in purchase history until someone records a sold outcome against it.";
  if (mode === "oversight") return "Sold, recovered, spoiled, donated, and disposed quantities appear after a farmer or trader records them.";
  return "Choose the listing and what happened to it. A purchase is not copied here unless you say that sale is the saved purchase.";
}

function FieldIssue({ active, message }: { active: boolean; message: string | null }) {
  if (!active || !message) return null;
  return (
    <p role="alert" className="field-error">
      {message}
    </p>
  );
}
