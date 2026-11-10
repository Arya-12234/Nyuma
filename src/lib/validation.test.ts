import { describe, expect, it } from "vitest";
import { DEFAULT_FORM } from "../data/scenarioData";
import { validateScenarioForm } from "./validation";

describe("validateScenarioForm", () => {
  it("accepts the default sample", () => {
    const result = validateScenarioForm(DEFAULT_FORM);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        produce: "Watermelon",
        quantityKg: 800,
        askingPriceKsh: 40,
        location: "Kitui",
        timeRemaining: "3 hours",
        mode: "surplus",
      });
    }
  });

  it("rejects an empty quantity, a negative quantity, and a blank price", () => {
    const empty = validateScenarioForm({ ...DEFAULT_FORM, quantityKg: "  " });
    expect(empty.ok).toBe(false);
    expect(empty.errors.quantityKg).toMatch(/Enter the available quantity/);

    const negative = validateScenarioForm({ ...DEFAULT_FORM, quantityKg: "-1" });
    expect(negative.errors.quantityKg).toMatch(/cannot be negative/);

    const price = validateScenarioForm({ ...DEFAULT_FORM, askingPriceKsh: "" });
    expect(price.errors.askingPriceKsh).toMatch(/asking price/);
  });

  it("rejects zero, words, and scientific notation in the price", () => {
    expect(validateScenarioForm({ ...DEFAULT_FORM, askingPriceKsh: "0" }).errors.askingPriceKsh).toMatch(
      /greater than zero/,
    );
    expect(validateScenarioForm({ ...DEFAULT_FORM, askingPriceKsh: "forty" }).errors.askingPriceKsh).toMatch(/valid price/);
    expect(validateScenarioForm({ ...DEFAULT_FORM, quantityKg: "8e2" }).errors.quantityKg).toMatch(/valid quantity/);
  });

  it("accepts a zero quantity and a decimal price", () => {
    const result = validateScenarioForm({ ...DEFAULT_FORM, quantityKg: "0", askingPriceKsh: "40.5" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quantityKg).toBe(0);
      expect(result.value.askingPriceKsh).toBe(40.5);
    }
  });
});
