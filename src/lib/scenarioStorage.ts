import type { PersistedScenario, ScenarioFormState } from "../types/decision";
import { LOCATIONS, PRODUCE_TYPES, SCENARIO_MODES, TIME_WINDOWS } from "../types/decision";

export const SCENARIO_STORAGE_KEY = "nyuma.decisionSupport.scenario.v1";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parsePersistedScenario(
  raw: unknown,
  knownBuyerIds: readonly string[],
): PersistedScenario | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;

  const scenario = parseForm(record.scenario);
  if (!scenario) return null;
  if (!Array.isArray(record.selectedBuyerIds)) return null;

  const ids: string[] = [];
  for (const id of record.selectedBuyerIds) {
    if (typeof id !== "string") return null;
    ids.push(id);
  }

  const known = new Set(knownBuyerIds);
  if (ids.some((id) => !known.has(id))) return null;

  return { version: 1, scenario, selectedBuyerIds: ids };
}

export function saveScenario(
  data: PersistedScenario,
  store: KeyValueStore,
): { ok: boolean; message: string } {
  try {
    store.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(data));
    return {
      ok: true,
      message: "Scenario saved in this browser. Nothing was sent to a server.",
    };
  } catch {
    return {
      ok: false,
      message: "This browser blocked local storage, so the scenario could not be saved.",
    };
  }
}

export function loadScenario(
  knownBuyerIds: readonly string[],
  store: KeyValueStore,
): { ok: true; data: PersistedScenario; message: string } | { ok: false; message: string } {
  let raw: string | null;
  try {
    raw = store.getItem(SCENARIO_STORAGE_KEY);
  } catch {
    return {
      ok: false,
      message: "This browser blocked local storage, so a saved scenario could not be read.",
    };
  }

  if (raw === null || raw === "") {
    return { ok: false, message: "No saved scenario is stored in this browser yet." };
  }

  try {
    const parsed = parsePersistedScenario(JSON.parse(raw), knownBuyerIds);
    if (!parsed) {
      return { ok: false, message: damagedMessage() };
    }
    return {
      ok: true,
      data: parsed,
      message: "Saved scenario loaded from this browser.",
    };
  } catch {
    return { ok: false, message: damagedMessage() };
  }
}

function damagedMessage(): string {
  return "The saved scenario could not be used. It was incomplete or damaged, so your current entries were left as they are.";
}

function parseForm(raw: unknown): ScenarioFormState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isOneOf(value.produce, PRODUCE_TYPES)) return null;
  if (!isOneOf(value.location, LOCATIONS)) return null;
  if (!isOneOf(value.timeRemaining, TIME_WINDOWS)) return null;
  if (!isOneOf(value.mode, SCENARIO_MODES)) return null;
  if (typeof value.quantityKg !== "string") return null;
  if (typeof value.askingPriceKsh !== "string") return null;

  return {
    produce: value.produce,
    location: value.location,
    timeRemaining: value.timeRemaining,
    mode: value.mode,
    quantityKg: value.quantityKg,
    askingPriceKsh: value.askingPriceKsh,
  };
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
