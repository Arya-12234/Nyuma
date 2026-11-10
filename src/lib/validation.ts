import { LOCATIONS, PRODUCE_TYPES, SCENARIO_MODES, TIME_WINDOWS } from "../types/decision";
import type { FormErrors, ProduceScenario, ScenarioFormState } from "../types/decision";

export type ValidationResult =
  | { ok: true; value: ProduceScenario; errors: FormErrors }
  | { ok: false; value: null; errors: FormErrors };

export function validateScenarioForm(form: ScenarioFormState): ValidationResult {
  const errors: FormErrors = {};

  if (!PRODUCE_TYPES.includes(form.produce)) {
    errors.produce = "Choose a produce type.";
  }
  if (!LOCATIONS.includes(form.location)) {
    errors.location = "Choose a location.";
  }
  if (!TIME_WINDOWS.includes(form.timeRemaining)) {
    errors.timeRemaining = "Choose how long you have to sell.";
  }
  if (!SCENARIO_MODES.includes(form.mode)) {
    errors.mode = "Choose whether this is surplus or a purchase.";
  }

  const quantity = readNumber(form.quantityKg, errors, "quantityKg", {
    empty: "Enter the available quantity in kilograms.",
    invalid: "Enter a valid quantity in kilograms.",
    negative: "Quantity cannot be negative.",
    allowZero: true,
  });

  const price = readNumber(form.askingPriceKsh, errors, "askingPriceKsh", {
    empty: "Enter an asking price per kilogram.",
    invalid: "Enter a valid price in Kenyan shillings.",
    negative: "Enter a price greater than zero.",
    allowZero: false,
  });

  if (Object.keys(errors).length > 0 || quantity === null || price === null) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    errors,
    value: {
      produce: form.produce,
      quantityKg: quantity,
      askingPriceKsh: price,
      location: form.location,
      timeRemaining: form.timeRemaining,
      mode: form.mode,
    },
  };
}

function readNumber(
  raw: string,
  errors: FormErrors,
  key: "quantityKg" | "askingPriceKsh",
  messages: { empty: string; invalid: string; negative: string; allowZero: boolean },
): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    errors[key] = messages.empty;
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    errors[key] = messages.invalid;
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    errors[key] = messages.invalid;
    return null;
  }
  if (value < 0 || (!messages.allowZero && value === 0)) {
    errors[key] = messages.negative;
    return null;
  }
  return value;
}
