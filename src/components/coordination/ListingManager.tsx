import { useContext, useEffect, useRef, useState } from "react";
import { LOCATIONS, PRODUCE_TYPES, TIME_WINDOWS } from "../../types/decision";
import type { Listing, ListingStatus } from "../../domain/records";
import { loadOwnedListing, loadOwnedListings, saveAccountListing } from "../../lib/accountCoordination";
import { browserCoordinationRepository } from "../../lib/coordinationClient";
import {
  EMPTY_LISTING_FORM,
  fieldForListingMessage,
  type ListingFormValues,
} from "../../lib/coordinationForms";
import {
  canEditListing,
  createListingRecord,
  listingLockedMessage,
  listingsForAccount,
  updateListingRecord,
} from "../../lib/coordinationWorkflow";
import type { SessionUser } from "../../lib/auth";
import { authorizeOwnRecord } from "../../lib/access";
import { EmptyState } from "../EmptyState";
import { useRequestGuard } from "../../lib/requestGuard";
import { CoordinationAccessContext, CoordinationAlert, reportAccessCode } from "./coordinationAccess";
import { priceText, quantityText } from "./useCoordination";

const STATUS_LABEL: Record<ListingStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
  withdrawn: "Withdrawn",
};

const KIND_LABEL = {
  expected: "Expected harvest",
  available: "Available now",
} as const;

interface ListingManagerProps {
  user: SessionUser;
  mode: "list" | "form";
  formHash: string;
  listHash: string;
  recordId: string | null;
  emptyTitle?: string;
  emptyBody?: string;
}

export function ListingManager({ user, mode, formHash, listHash, recordId, emptyTitle, emptyBody }: ListingManagerProps) {
  if (mode === "list") {
    return (
      <ListingIndex
        user={user}
        formHash={formHash}
        emptyTitle={emptyTitle ?? "You haven't listed any produce yet."}
        emptyBody={emptyBody ?? "Start by adding your expected harvest."}
      />
    );
  }
  return <ListingEditor user={user} listHash={listHash} recordId={recordId} />;
}

function ListingIndex({
  user,
  formHash,
  emptyTitle,
  emptyBody,
}: {
  user: SessionUser;
  formHash: string;
  emptyTitle: string;
  emptyBody: string;
}) {
  const access = useContext(CoordinationAccessContext);
  const accessRef = useRef(access);
  accessRef.current = access;
  const token = access?.token ?? "";
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${user.id}:${user.sample}:${token}:${attempt}`);
  const [listings, setListings] = useState<readonly Listing[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const ticket = guard.issue();
    setListings(null);
    setMessage(null);
    const current = accessRef.current;
    void loadOwnedListings({
      user,
      token: user.sample ? null : current?.token ?? null,
      api: user.sample ? null : current?.api ?? null,
      sampleRepository: user.sample ? browserCoordinationRepository() : null,
    }).then((result) => {
      if (!guard.accept(ticket)) return;
      if (!result.ok) {
        setMessage(result.message);
        setListings(user.sample ? [] : null);
        reportAccessCode(accessRef.current, result.code);
        return;
      }
      setListings(user.sample ? listingsForAccount(result.listings, user.id) : result.listings);
    });
  }, [user, guard, token, attempt]);

  return (
    <div className="record-desk">
      <p>
        <a className="btn btn-lime" href={formHash}>
          Add produce
        </a>
      </p>
      {listings === null && !message ? <p role="status">Loading your listings…</p> : null}
      {message ? <CoordinationAlert message={message} /> : null}
      {listings && listings.length === 0 ? (
        <EmptyState title={emptyTitle} body={emptyBody} />
      ) : listings ? (
        <ListingCards listings={listings} formHash={formHash} />
      ) : null}
    </div>
  );
}

export function ListingCards({ listings, formHash }: { listings: readonly Listing[]; formHash: string }) {
  return (
    <ul className="record-list">
      {listings.map((listing) => (
        <li key={listing.id}>
          <h3>
            {listing.commodity} <span className="pill pill-ok">{STATUS_LABEL[listing.status]}</span>
          </h3>
          <p>
            {quantityText(listing.quantity)} · {KIND_LABEL[listing.quantityKind]} · {listing.location}
          </p>
          <p>
            {KIND_LABEL[listing.quantityKind] === "Expected harvest"
              ? "Expected harvest is not produce that is ready to collect."
              : "This produce is marked as available now."}{" "}
            Collection window: {listing.availabilityWindow}. {priceText(listing.askingPriceKshPerKg)}.
          </p>
          {canEditListing(listing.status) ? (
            <a href={`${formHash}?id=${listing.id}`}>Edit</a>
          ) : (
            <a href={`${formHash}?id=${listing.id}`}>View</a>
          )}
        </li>
      ))}
    </ul>
  );
}

function ListingEditor({
  user,
  listHash,
  recordId,
}: {
  user: SessionUser;
  listHash: string;
  recordId: string | null;
}) {
  const [values, setValues] = useState<ListingFormValues>(EMPTY_LISTING_FORM);
  const [existing, setExisting] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(recordId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"closed" | "withdrawn" | null>(null);
  const access = useContext(CoordinationAccessContext);
  const accessRef = useRef(access);
  accessRef.current = access;
  const token = access?.token ?? "";
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${user.id}:${user.sample}:${recordId ?? ""}:${token}:${attempt}`);

  useEffect(() => {
    if (!recordId) {
      setExisting(null);
      setLoading(false);
      return;
    }
    const ticket = guard.issue();
    setExisting(null);
    setLoading(true);
    setBusy(false);
    setError(null);
    const current = accessRef.current;
    void loadOwnedListing({
      user,
      id: recordId,
      token: user.sample ? null : current?.token ?? null,
      api: user.sample ? null : current?.api ?? null,
      sampleRepository: user.sample ? browserCoordinationRepository() : null,
    }).then((result) => {
      if (!guard.accept(ticket)) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.message);
        reportAccessCode(accessRef.current, result.code);
        return;
      }
      if (user.sample) {
        const gate = authorizeOwnRecord(user, "edit-listing", result.listing.ownerId);
        if (!gate.ok) {
          setError(gate.message);
          return;
        }
      }
      setExisting(result.listing);
      setValues({
        commodity: result.listing.commodity,
        quantity: String(result.listing.quantity),
        quantityKind: result.listing.quantityKind,
        location: result.listing.location,
        availabilityWindow: result.listing.availabilityWindow,
        askingPrice: result.listing.askingPriceKshPerKg === null ? "" : String(result.listing.askingPriceKshPerKg),
      });
    });
  }, [recordId, user, guard, token, attempt]);

  const locked = existing ? !canEditListing(existing.status) : false;
  const errorField = error ? fieldForListingMessage(error) : null;

  async function save(status: "draft" | "open" | "closed" | "withdrawn") {
    if (!user.sample) {
      if (!existing && (status === "closed" || status === "withdrawn")) return;
      const ticket = guard.issue();
      setBusy(true);
      setError(null);
      const result = await saveAccountListing({
        user,
        token: access?.token ?? null,
        api: access?.api ?? null,
        existing,
        values,
        status,
      });
      if (!guard.accept(ticket)) return;
      setBusy(false);
      setConfirming(null);
      if (!result.ok) {
        setError(result.message);
        if (result.code === "unauthenticated" || result.code === "not-found" || result.code === "account-disabled") setExisting(null);
        reportAccessCode(access, result.code);
        return;
      }
      setExisting(result.value);
      setNotice("Listing saved.");
      if (!recordId) window.location.hash = `${window.location.hash.split("?")[0]}?id=${result.value.id}`;
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError("This browser blocked local storage, so the listing could not be saved.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = existing
      ? await updateListingRecord(repository, user, existing.id, values, status)
      : status === "closed" || status === "withdrawn"
        ? null
        : await createListingRecord(repository, user, values, status);
    setBusy(false);
    setConfirming(null);
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setExisting(result.value);
    setNotice("Listing saved.");
    if (!recordId) window.location.hash = `${window.location.hash.split("?")[0]}?id=${result.value.id}`;
  }

  if (loading) return <p role="status">Loading this listing…</p>;
  if (error && !existing && recordId) {
    return (
      <div>
        <p role="alert">{error}</p>
        <a href={listHash}>Back to my listings</a>
      </div>
    );
  }

  return (
    <form
      className="panel record-form"
      data-form="listing"
      onSubmit={(event) => event.preventDefault()}
      noValidate
    >
      <p className="setup-note">Required fields are marked. Asking price can be left blank.</p>
      {locked && existing ? <p role="status">{listingLockedMessage(existing.status)}</p> : null}
      <div className="form-stack">
        <div className="field">
          <label htmlFor="listing-commodity">
            Produce <span className="req">Required</span>
          </label>
          {existing ? (
            <p id="listing-commodity">{existing.commodity}. Produce type stays as first saved.</p>
          ) : (
            <select
              id="listing-commodity"
              value={values.commodity}
              aria-required="true"
              aria-invalid={errorField === "commodity" ? true : undefined}
              disabled={locked || busy}
              onChange={(event) => setValues((current) => ({ ...current, commodity: event.target.value }))}
            >
              <option value="">Choose produce</option>
              {PRODUCE_TYPES.map((produce) => (
                <option key={produce} value={produce}>
                  {produce}
                </option>
              ))}
            </select>
          )}
        </div>
        <fieldset>
          <legend>
            What kind of quantity is this? <span className="req">Required</span>
          </legend>
          <label className="mode-option">
            <input
              type="radio"
              name="quantity-kind"
              value="expected"
              checked={values.quantityKind === "expected"}
              disabled={locked || busy}
              onChange={() => setValues((current) => ({ ...current, quantityKind: "expected" }))}
            />
            Expected harvest — not ready to collect yet
          </label>
          <label className="mode-option">
            <input
              type="radio"
              name="quantity-kind"
              value="available"
              checked={values.quantityKind === "available"}
              disabled={locked || busy}
              onChange={() => setValues((current) => ({ ...current, quantityKind: "available" }))}
            />
            Available now — ready to collect
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="listing-quantity">
            Quantity (kg) <span className="req">Required</span>
          </label>
          <input
            id="listing-quantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder="800"
            aria-required="true"
            aria-invalid={errorField === "quantity" ? true : undefined}
            aria-describedby="listing-quantity-help"
            disabled={locked || busy}
            value={values.quantity}
            onChange={(event) => setValues((current) => ({ ...current, quantity: event.target.value }))}
          />
          <p id="listing-quantity-help" className="setup-note">
            For example, 800. Use kilograms, up to 3 decimal places.
          </p>
        </div>
        <div className="field">
          <label htmlFor="listing-location">
            Location <span className="req">Required</span>
          </label>
          <select
            id="listing-location"
            value={values.location}
            aria-required="true"
            disabled={locked || busy}
            onChange={(event) => setValues((current) => ({ ...current, location: event.target.value }))}
          >
            <option value="">Choose a location</option>
            {LOCATIONS.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="listing-window">
            Collection window <span className="req">Required</span>
          </label>
          <select
            id="listing-window"
            value={values.availabilityWindow}
            aria-required="true"
            disabled={locked || busy}
            onChange={(event) => setValues((current) => ({ ...current, availabilityWindow: event.target.value }))}
          >
            <option value="">Choose a window</option>
            {TIME_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {window}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="listing-price">Asking price (KSh/kg) <span className="opt">Optional</span></label>
          <input
            id="listing-price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40"
            aria-invalid={errorField === "askingPrice" ? true : undefined}
            aria-describedby="listing-price-help"
            disabled={locked || busy}
            value={values.askingPrice}
            onChange={(event) => setValues((current) => ({ ...current, askingPrice: event.target.value }))}
          />
          <p id="listing-price-help" className="setup-note">
            For example, 40. Leave blank if you have not set a price.
          </p>
        </div>
      </div>
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
      {confirming ? (
        <div className="confirm-panel" role="alertdialog" aria-labelledby="confirm-title">
          <h3 id="confirm-title">{confirming === "closed" ? "Close this listing?" : "Withdraw this listing?"}</h3>
          <p>
            {confirming === "closed"
              ? "It will stay on record, and it will no longer be open."
              : "It will stay on record, and it will not be open."}
          </p>
          <div className="scenario-controls">
            <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save(confirming)}>
              {confirming === "closed" ? "Close listing" : "Withdraw listing"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
              Keep it as it is
            </button>
          </div>
        </div>
      ) : null}
      <div className="scenario-controls">
        {!locked && !existing ? (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save("draft")}>
              Save draft
            </button>
            <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save("open")}>
              Open listing
            </button>
          </>
        ) : null}
        {!locked && existing?.status === "draft" ? (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save("draft")}>
              Save draft
            </button>
            <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save("open")}>
              Open listing
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming("withdrawn")}>
              Withdraw
            </button>
          </>
        ) : null}
        {!locked && existing?.status === "open" ? (
          <>
            <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save("open")}>
              Save changes
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming("closed")}>
              Close
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming("withdrawn")}>
              Withdraw
            </button>
          </>
        ) : null}
        <a className="btn btn-secondary" href={listHash}>
          Cancel
        </a>
      </div>
      {busy ? <p role="status">Saving…</p> : null}
    </form>
  );
}
