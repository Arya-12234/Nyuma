import type { BuyerDemand, Listing } from "./records";
import { failure, success, type DomainResult } from "./result";
import { parseBuyerDemand, parseListing } from "./validateRecords";
import { evaluateScenario } from "../lib/decisionEngine";
import { validateScenarioForm } from "../lib/validation";
import type { Buyer, DecisionResult, FormErrors, ProduceScenario, ScenarioFormState } from "../types/decision";

/**
 * A listing is supply, so the engine scenario is always surplus.
 * Buyer names are the demand's buyer id: a demand record has no display name.
 * Location is passed through and is not used as a transport cost.
 */
export interface ListingMatch {
  scenario: ProduceScenario;
  buyers: readonly Buyer[];
  selectedDemandIds: readonly string[];
  decision: DecisionResult;
}

export function matchListingToDemand(listing: Listing, demands: readonly BuyerDemand[]): DomainResult<ListingMatch> {
  if (!Array.isArray(demands)) {
    return failure("invalid", "Buyer demand must be a list. The match was not calculated.");
  }

  const parsedListing = parseListing(listing);
  if (!parsedListing.ok) return failure(parsedListing.code, `${parsedListing.message} The match was not calculated.`);
  if (parsedListing.value.status !== "open") {
    return failure(
      "relationship",
      `Match a listing only while it is open. This listing is ${parsedListing.value.status}. The match was not calculated.`,
    );
  }

  const parsedDemands: BuyerDemand[] = [];
  for (let index = 0; index < demands.length; index += 1) {
    const parsed = parseBuyerDemand(demands[index], `buyerDemands[${index}]`);
    if (!parsed.ok) return failure(parsed.code, `${parsed.message} The match was not calculated.`);
    parsedDemands.push(parsed.value);
  }

  const duplicateId = duplicateDemandId(parsedDemands);
  if (duplicateId) {
    return failure("conflict", `Two buyer demand records use the id ${duplicateId}. The match was not calculated.`);
  }

  const buyers: Buyer[] = [];
  for (const demand of parsedDemands) {
    if (demand.indicativePriceKshPerKg === null) {
      return failure(
        "invalid",
        `Buyer demand ${demand.id} has no indicative price per kilogram. The match was not calculated.`,
      );
    }
    buyers.push(toBuyer(demand, demand.indicativePriceKshPerKg));
  }

  const form = scenarioForm(parsedListing.value);
  const validated = validateScenarioForm(form);
  if (!validated.ok) {
    return failure("invalid", `${validationMessage(validated.errors)} The match was not calculated.`);
  }

  const selectedDemandIds = parsedDemands.filter((demand) => demand.status === "open").map((demand) => demand.id);
  const decision = evaluateScenario(validated.value, buyers, selectedDemandIds);

  return success({
    scenario: validated.value,
    buyers,
    selectedDemandIds,
    decision,
  });
}

function scenarioForm(listing: Listing): ScenarioFormState {
  return {
    produce: listing.commodity,
    quantityKg: decimalString(listing.quantity),
    askingPriceKsh: listing.askingPriceKshPerKg === null ? "" : decimalString(listing.askingPriceKshPerKg),
    location: listing.location,
    timeRemaining: listing.availabilityWindow,
    mode: "surplus",
  };
}

function toBuyer(demand: BuyerDemand, indicativePriceKsh: number): Buyer {
  return {
    id: demand.id,
    name: demand.buyerId,
    location: demand.preferredLocation,
    produce: demand.commodity,
    quantityKg: demand.requestedQuantity,
    indicativePriceKsh,
    collection: demand.collectionWindow,
  };
}

function duplicateDemandId(demands: readonly BuyerDemand[]): string | null {
  const seen = new Set<string>();
  for (const demand of demands) {
    if (seen.has(demand.id)) return demand.id;
    seen.add(demand.id);
  }
  return null;
}

function validationMessage(errors: FormErrors): string {
  return Object.values(errors)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function decimalString(value: number): string {
  if (!Number.isFinite(value)) return "";
  const negative = value < 0;
  const milli = Math.round(Math.abs(value) * 1000);
  const whole = Math.trunc(milli / 1000);
  const fraction = milli % 1000;
  const body =
    fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
  return negative ? `-${body}` : body;
}
