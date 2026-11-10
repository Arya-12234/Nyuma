import { useContext, useEffect, useRef, useState } from "react";
import { LOCATIONS, PRODUCE_TYPES, TIME_WINDOWS } from "../../types/decision";
import type { BuyerDemand, BuyerDemandStatus } from "../../domain/records";
import { authorizeOwnRecord } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { loadOwnedRequirement, loadOwnedRequirements, saveAccountRequirement } from "../../lib/accountCoordination";
import { browserCoordinationRepository } from "../../lib/coordinationClient";
import { EMPTY_DEMAND_FORM, fieldForDemandMessage, type DemandFormValues } from "../../lib/coordinationForms";
import {
  canEditDemand,
  createDemandRecord,
  demandLockedMessage,
  demandsForAccount,
  updateDemandRecord,
} from "../../lib/coordinationWorkflow";
import { EmptyState } from "../EmptyState";
import { useRequestGuard } from "../../lib/requestGuard";
import { CoordinationAccessContext, CoordinationAlert, reportAccessCode } from "./coordinationAccess";
import { priceText, quantityText } from "./useCoordination";

const STATUS_LABEL: Record<BuyerDemandStatus, string> = {
  open: "Open",
  closed: "Closed",
  withdrawn: "Withdrawn",
};

interface DemandManagerProps {
  user: SessionUser;
  mode: "list" | "form";
  formHash: string;
  listHash: string;
  recordId: string | null;
}

export function DemandManager({ user, mode, formHash, listHash, recordId }: DemandManagerProps) {
  if (mode === "list") return <DemandIndex user={user} formHash={formHash} />;
  return <DemandEditor user={user} listHash={listHash} recordId={recordId} />;
}

function DemandIndex({ user, formHash }: { user: SessionUser; formHash: string }) {
  const access = useContext(CoordinationAccessContext);
  const accessRef = useRef(access);
  accessRef.current = access;
  const token = access?.token ?? "";
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${user.id}:${user.sample}:${token}:${attempt}`);
  const [demands, setDemands] = useState<readonly BuyerDemand[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const ticket = guard.issue();
    setDemands(null);
    setMessage(null);
    const current = accessRef.current;
    void loadOwnedRequirements({
      user,
      token: user.sample ? null : current?.token ?? null,
      api: user.sample ? null : current?.api ?? null,
      sampleRepository: user.sample ? browserCoordinationRepository() : null,
    }).then((result) => {
      if (!guard.accept(ticket)) return;
      if (!result.ok) {
        setMessage(result.message);
        setDemands(user.sample ? [] : null);
        reportAccessCode(accessRef.current, result.code);
        return;
      }
      setDemands(user.sample ? demandsForAccount(result.requirements, user.id) : result.requirements);
    });
  }, [user, guard, token, attempt]);

  return (
    <div className="record-desk">
      <p>
        <a className="btn btn-lime" href={formHash}>
          Submit a requirement
        </a>
      </p>
      {demands === null && !message ? <p role="status">Loading your requirements…</p> : null}
      {message ? <CoordinationAlert message={message} /> : null}
      {demands && demands.length === 0 ? (
        <EmptyState
          title="You haven't submitted any purchasing requirements."
          body="Add your demand to discover available produce."
        />
      ) : demands ? (
        <DemandCards demands={demands} formHash={formHash} />
      ) : null}
    </div>
  );
}

export function DemandCards({ demands, formHash }: { demands: readonly BuyerDemand[]; formHash: string }) {
  return (
    <ul className="record-list">
      {demands.map((demand) => (
        <li key={demand.id}>
          <h3>
            {demand.commodity} <span className="pill pill-ok">{STATUS_LABEL[demand.status]}</span>
          </h3>
          <p>
            {quantityText(demand.requestedQuantity)} requested · {demand.preferredLocation} · {demand.collectionWindow}
          </p>
          <p>
            {priceText(demand.indicativePriceKshPerKg)}. This is a purchasing requirement, not a confirmed order.
          </p>
          {canEditDemand(demand.status) ? (
            <a href={`${formHash}?id=${demand.id}`}>Edit</a>
          ) : (
            <a href={`${formHash}?id=${demand.id}`}>View</a>
          )}
        </li>
      ))}
    </ul>
  );
}

function DemandEditor({
  user,
  listHash,
  recordId,
}: {
  user: SessionUser;
  listHash: string;
  recordId: string | null;
}) {
  const [values, setValues] = useState<DemandFormValues>(EMPTY_DEMAND_FORM);
  const [existing, setExisting] = useState<BuyerDemand | null>(null);
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
    void loadOwnedRequirement({
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
        const gate = authorizeOwnRecord(user, "edit-demand", result.requirement.buyerId);
        if (!gate.ok) {
          setError(gate.message);
          return;
        }
      }
      setExisting(result.requirement);
      setValues({
        commodity: result.requirement.commodity,
        quantity: String(result.requirement.requestedQuantity),
        location: result.requirement.preferredLocation,
        collectionWindow: result.requirement.collectionWindow,
        indicativePrice: result.requirement.indicativePriceKshPerKg === null ? "" : String(result.requirement.indicativePriceKshPerKg),
      });
    });
  }, [recordId, user, guard, token, attempt]);

  const locked = existing ? !canEditDemand(existing.status) : false;
  const errorField = error ? fieldForDemandMessage(error) : null;

  async function save(status: BuyerDemandStatus) {
    if (!user.sample) {
      const ticket = guard.issue();
      setBusy(true);
      setError(null);
      const result = await saveAccountRequirement({
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
      setNotice("Purchasing requirement saved.");
      if (!recordId) window.location.hash = `${window.location.hash.split("?")[0]}?id=${result.value.id}`;
      return;
    }
    const repository = browserCoordinationRepository();
    if (!repository) {
      setError("This browser blocked local storage, so the requirement could not be saved.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = existing
      ? await updateDemandRecord(repository, user, existing.id, values, status)
      : await createDemandRecord(repository, user, values);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setExisting(result.value);
    setNotice("Purchasing requirement saved.");
    if (!recordId) window.location.hash = `${window.location.hash.split("?")[0]}?id=${result.value.id}`;
  }

  if (loading) return <p role="status">Loading this requirement…</p>;
  if (error && !existing && recordId) {
    return (
      <div>
        <p role="alert">{error}</p>
        <a href={listHash}>Back to my demand</a>
      </div>
    );
  }

  return (
    <form className="panel record-form" data-form="demand" onSubmit={(event) => event.preventDefault()} noValidate>
      <p className="setup-note">
        Saving publishes this requirement as open. You can close or withdraw it later. It is not a confirmed order.
      </p>
      {locked && existing ? <p role="status">{demandLockedMessage(existing.status)}</p> : null}
      <div className="form-stack">
        <div className="field">
          <label htmlFor="demand-commodity">
            Produce <span className="req">Required</span>
          </label>
          {existing ? (
            <p id="demand-commodity">{existing.commodity}. Produce type stays as first saved.</p>
          ) : (
            <select
              id="demand-commodity"
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
        <div className="field">
          <label htmlFor="demand-quantity">
            Quantity wanted (kg) <span className="req">Required</span>
          </label>
          <input
            id="demand-quantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder="300"
            aria-required="true"
            aria-invalid={errorField === "quantity" ? true : undefined}
            aria-describedby="demand-quantity-help"
            disabled={locked || busy}
            value={values.quantity}
            onChange={(event) => setValues((current) => ({ ...current, quantity: event.target.value }))}
          />
          <p id="demand-quantity-help" className="setup-note">
            For example, 300. Use kilograms, up to 3 decimal places.
          </p>
        </div>
        <div className="field">
          <label htmlFor="demand-location">
            Preferred location <span className="req">Required</span>
          </label>
          <select
            id="demand-location"
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
          <label htmlFor="demand-window">
            Collection window <span className="req">Required</span>
          </label>
          <select
            id="demand-window"
            value={values.collectionWindow}
            aria-required="true"
            disabled={locked || busy}
            onChange={(event) => setValues((current) => ({ ...current, collectionWindow: event.target.value }))}
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
          <label htmlFor="demand-price">Indicative price (KSh/kg) <span className="opt">Optional</span></label>
          <input
            id="demand-price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40"
            aria-invalid={errorField === "indicativePrice" ? true : undefined}
            aria-describedby="demand-price-help"
            disabled={locked || busy}
            value={values.indicativePrice}
            onChange={(event) => setValues((current) => ({ ...current, indicativePrice: event.target.value }))}
          />
          <p id="demand-price-help" className="setup-note">
            For example, 40. This price has not been agreed.
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
        <div className="confirm-panel" role="alertdialog" aria-labelledby="demand-confirm-title">
          <h3 id="demand-confirm-title">
            {confirming === "closed" ? "Close this requirement?" : "Withdraw this requirement?"}
          </h3>
          <p>It will stay on record, and it will no longer be open.</p>
          <div className="scenario-controls">
            <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save(confirming)}>
              {confirming === "closed" ? "Close requirement" : "Withdraw requirement"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
              Keep it open
            </button>
          </div>
        </div>
      ) : null}
      <div className="scenario-controls">
        {!locked && !existing ? (
          <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void save("open")}>
            Submit requirement
          </button>
        ) : null}
        {!locked && existing ? (
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
