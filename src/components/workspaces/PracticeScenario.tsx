import { useMemo, useState } from "react";
import { DEFAULT_FORM, DEFAULT_SELECTED_IDS, SAMPLE_BUYERS } from "../../data/scenarioData";
import { authorizeAction } from "../../lib/access";
import type { SessionUser } from "../../lib/auth";
import { describeBuyer, evaluateScenario } from "../../lib/decisionEngine";
import { decisionHeadline } from "../../lib/decisionPresentation";
import { formatKg } from "../../lib/format";
import { loadScenario, saveScenario, type KeyValueStore } from "../../lib/scenarioStorage";
import { validateScenarioForm } from "../../lib/validation";
import type { ScenarioFormState } from "../../types/decision";
import { AllocationChart } from "../AllocationChart";
import { BuyerAllocationTable } from "../BuyerAllocationTable";
import { BuyerDemandPanel } from "../BuyerDemandPanel";
import { DecisionMetrics } from "../DecisionMetrics";
import { RecommendationList } from "../RecommendationList";
import { ScenarioForm } from "../ScenarioForm";

const knownBuyerIds = SAMPLE_BUYERS.map((buyer) => buyer.id);

const PRACTICE_NOTE =
  "Practice scenario. This uses illustrative sample information. A result is not an actual buyer commitment. Indicative gross sales are not confirmed revenue. Saving or resetting this scenario does not create a listing, an agreement, or a purchase.";

export function PracticeScenario({ user }: { user: SessionUser }) {
  const [form, setForm] = useState<ScenarioFormState>(DEFAULT_FORM);
  const [selectedIds, setSelectedIds] = useState<string[]>([...DEFAULT_SELECTED_IDS]);
  const [notice, setNotice] = useState<string | null>(null);
  const canEdit = authorizeAction(user, "edit-scenario").ok;
  const canSave = authorizeAction(user, "save-scenario").ok;

  const model = useMemo(() => {
    const validation = validateScenarioForm(form);
    const matches = SAMPLE_BUYERS.map((buyer) =>
      describeBuyer(
        { produce: form.produce, timeRemaining: form.timeRemaining },
        buyer,
        selectedIds.includes(buyer.id),
      ),
    );
    const result = validation.ok ? evaluateScenario(validation.value, SAMPLE_BUYERS, selectedIds) : null;
    return { validation, matches, result };
  }, [form, selectedIds]);

  function update<K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) {
    const gate = authorizeAction(user, "edit-scenario");
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  function toggleBuyer(buyerId: string) {
    const gate = authorizeAction(user, "edit-scenario");
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    setSelectedIds((current) =>
      current.includes(buyerId) ? current.filter((id) => id !== buyerId) : [...current, buyerId],
    );
    setNotice(null);
  }

  function resetScenario() {
    const gate = authorizeAction(user, "edit-scenario");
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    setForm(DEFAULT_FORM);
    setSelectedIds([...DEFAULT_SELECTED_IDS]);
    setNotice("Sample scenario restored: 800 kg of watermelon at KSh 40/kg in Kitui, with 3 hours to sell.");
  }

  function saveCurrent() {
    const gate = authorizeAction(user, "save-scenario");
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    const store = browserStore();
    if (!store) {
      setNotice("This browser blocked local storage, so the scenario could not be saved.");
      return;
    }
    setNotice(saveScenario({ version: 1, scenario: form, selectedBuyerIds: selectedIds }, store).message);
  }

  function loadSaved() {
    const gate = authorizeAction(user, "edit-scenario");
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    const store = browserStore();
    if (!store) {
      setNotice("This browser blocked local storage, so a saved scenario could not be read.");
      return;
    }
    const outcome = loadScenario(knownBuyerIds, store);
    if (!outcome.ok) {
      setNotice(outcome.message);
      return;
    }
    setForm(outcome.data.scenario);
    setSelectedIds(outcome.data.selectedBuyerIds);
    setNotice(outcome.message);
  }

  const result = model.result;

  return (
    <div data-view="practice-scenario">
      <p className="demo-flag">{PRACTICE_NOTE}</p>
      {result ? (
        <>
          <p className="answer">{decisionHeadline(form.mode, result.metrics)}</p>
          <DecisionMetrics metrics={result.metrics} mode={form.mode} />
          <dl className="supply-board">
            <div>
              <dt>Illustrative supply</dt>
              <dd>{formatKg(result.metrics.availableQuantityKg)}</dd>
              <p>Sample load. Not a saved listing.</p>
            </div>
            <div>
              <dt>Illustrative match</dt>
              <dd>{formatKg(result.metrics.potentiallyMatchedKg)}</dd>
              <p>Possible match in this sample. Not an agreement.</p>
            </div>
            <div>
              <dt>Not taken in the sample</dt>
              <dd>{formatKg(result.metrics.unallocatedKg)}</dd>
              <p>Left after the selected sample buyers. Not your exposed produce.</p>
            </div>
          </dl>
          <div className="dash-split">
            <AllocationChart allocations={result.allocations} metrics={result.metrics} />
            <RecommendationList recommendations={result.recommendations} />
          </div>
          {canEdit ? <BuyerDemandPanel matches={model.matches} onToggle={toggleBuyer} /> : null}
          <BuyerAllocationTable allocations={result.allocations} />
        </>
      ) : (
        <div className="paused" role="status">
          <h3>The result is waiting on a valid quantity and price.</h3>
          <p>Correct the highlighted field. The sample buyers stay available.</p>
          {canEdit ? <BuyerDemandPanel matches={model.matches} onToggle={toggleBuyer} /> : null}
        </div>
      )}
      <ScenarioPanel
        form={form}
        errors={model.validation.errors}
        notice={notice}
        canEdit={canEdit}
        canSave={canSave}
        onChange={update}
        onReset={resetScenario}
        onSave={saveCurrent}
        onLoad={loadSaved}
      />
    </div>
  );
}

function ScenarioPanel({
  form,
  errors,
  notice,
  canEdit,
  canSave,
  onChange,
  onReset,
  onSave,
  onLoad,
}: {
  form: ScenarioFormState;
  errors: ReturnType<typeof validateScenarioForm>["errors"];
  notice: string | null;
  canEdit: boolean;
  canSave: boolean;
  onChange: <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => void;
  onReset: () => void;
  onSave: () => void;
  onLoad: () => void;
}) {
  return (
    <section className="panel quick" id="report" aria-labelledby="report-title">
      <h3 id="report-title">Edit the sample</h3>
      <p className="setup-note">These controls change the practice scenario only.</p>
      {canEdit ? (
        <ScenarioForm form={form} errors={errors} onChange={onChange} />
      ) : (
        <p role="alert">This sample role cannot edit the trader scenario.</p>
      )}
      <div className="scenario-controls">
        {canEdit ? (
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Reset
          </button>
        ) : null}
        {canSave ? (
          <button type="button" className="btn btn-secondary" onClick={onSave}>
            Save
          </button>
        ) : (
          <p role="alert">This sample role cannot save the trader scenario.</p>
        )}
        {canEdit ? (
          <button type="button" className="btn btn-lime" onClick={onLoad}>
            Load saved
          </button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={notice ? "notice" : "sr-only"}>
        {notice ?? ""}
      </p>
      <p className="setup-note">Location is kept with the scenario. Transport cost is not estimated.</p>
    </section>
  );
}

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
