import { describe, expect, it } from "vitest";
import { DEFAULT_FORM } from "../data/scenarioData";
import type { PersistedScenario } from "../types/decision";
import { loadScenario, parsePersistedScenario, saveScenario, type KeyValueStore } from "./scenarioStorage";

const known = ["nairobi-fresh-produce", "city-market-traders", "green-basket-wholesale"];

function memoryStore(initial?: string): KeyValueStore & { snapshot: () => string | null } {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    snapshot: () => value,
  };
}

const saved: PersistedScenario = {
  version: 1,
  scenario: { ...DEFAULT_FORM, quantityKg: "450", mode: "purchase" },
  selectedBuyerIds: ["city-market-traders"],
};

describe("scenario storage", () => {
  it("saves and loads a scenario without changing the fields", () => {
    const store = memoryStore();
    const save = saveScenario(saved, store);
    expect(save.ok).toBe(true);
    const loaded = loadScenario(known, store);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data).toEqual(saved);
  });

  it("reports a missing save and a damaged save without throwing", () => {
    expect(loadScenario(known, memoryStore()).ok).toBe(false);
    expect(loadScenario(known, memoryStore()).message).toMatch(/No saved scenario/);
    expect(loadScenario(known, memoryStore("{")).message).toMatch(/could not be used/);
    expect(loadScenario(known, memoryStore(JSON.stringify({ version: 2 }))).message).toMatch(/could not be used/);
  });

  it("rejects unknown buyers and accepts an empty selection", () => {
    expect(parsePersistedScenario({ ...saved, selectedBuyerIds: ["not-a-buyer"] }, known)).toBeNull();
    expect(parsePersistedScenario({ ...saved, selectedBuyerIds: [] }, known)?.selectedBuyerIds).toEqual([]);
  });

  it("returns a visible message when storage throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveScenario(saved, broken).message).toMatch(/blocked local storage/);
    expect(loadScenario(known, broken).message).toMatch(/blocked local storage/);
  });
});
