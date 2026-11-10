import { MODE_OPTIONS } from "../data/scenarioData";
import { LOCATIONS, PRODUCE_TYPES, TIME_WINDOWS } from "../types/decision";
import type { FormErrors, ScenarioFormState } from "../types/decision";

interface ScenarioFormProps {
  form: ScenarioFormState;
  errors: FormErrors;
  onChange: <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => void;
}

export function ScenarioForm({ form, errors, onChange }: ScenarioFormProps) {
  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate>
      <div className="fields">
        <div className="field">
          <label htmlFor="produce-type">Produce</label>
          <select
            id="produce-type"
            value={form.produce}
            aria-invalid={errors.produce ? true : undefined}
            aria-describedby={errors.produce ? "produce-error" : undefined}
            onChange={(event) => onChange("produce", event.target.value as ScenarioFormState["produce"])}
          >
            {PRODUCE_TYPES.map((produce) => (
              <option key={produce} value={produce}>
                {produce}
              </option>
            ))}
          </select>
          {errors.produce ? (
            <p className="field-error" id="produce-error">
              {errors.produce}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="location">Location</label>
          <select
            id="location"
            value={form.location}
            aria-invalid={errors.location ? true : undefined}
            aria-describedby={errors.location ? "location-error" : undefined}
            onChange={(event) => onChange("location", event.target.value as ScenarioFormState["location"])}
          >
            {LOCATIONS.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </select>
          {errors.location ? (
            <p className="field-error" id="location-error">
              {errors.location}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="available-quantity">
            {form.mode === "purchase" ? "Quantity to consider (kg)" : "Quantity (kg)"}
          </label>
          <input
            id="available-quantity"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={form.quantityKg}
            aria-invalid={errors.quantityKg ? true : undefined}
            aria-describedby={errors.quantityKg ? "quantity-error" : undefined}
            onChange={(event) => onChange("quantityKg", event.target.value)}
          />
          {errors.quantityKg ? (
            <p className="field-error" id="quantity-error">
              {errors.quantityKg}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="asking-price">Asking price (KSh/kg)</label>
          <input
            id="asking-price"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={form.askingPriceKsh}
            aria-invalid={errors.askingPriceKsh ? true : undefined}
            aria-describedby={errors.askingPriceKsh ? "price-error" : undefined}
            onChange={(event) => onChange("askingPriceKsh", event.target.value)}
          />
          {errors.askingPriceKsh ? (
            <p className="field-error" id="price-error">
              {errors.askingPriceKsh}
            </p>
          ) : null}
        </div>

        <div className="field field-wide">
          <label htmlFor="time-remaining">Selling window</label>
          <select
            id="time-remaining"
            value={form.timeRemaining}
            aria-invalid={errors.timeRemaining ? true : undefined}
            aria-describedby={errors.timeRemaining ? "time-error" : undefined}
            onChange={(event) => onChange("timeRemaining", event.target.value as ScenarioFormState["timeRemaining"])}
          >
            {TIME_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {window}
              </option>
            ))}
          </select>
          {errors.timeRemaining ? (
            <p className="field-error" id="time-error">
              {errors.timeRemaining}
            </p>
          ) : null}
        </div>

        <fieldset className="field field-wide mode-fieldset">
          <legend>Scenario</legend>
          <div className="mode-options">
            {MODE_OPTIONS.map((option) => (
              <label key={option.value} className={form.mode === option.value ? "mode-option is-selected" : "mode-option"}>
                <input
                  type="radio"
                  name="scenario-mode"
                  value={option.value}
                  checked={form.mode === option.value}
                  onChange={() => onChange("mode", option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {errors.mode ? <p className="field-error">{errors.mode}</p> : null}
        </fieldset>
      </div>
    </form>
  );
}
