import { LOCATIONS, PRODUCE_TYPES, TIME_WINDOWS } from "../types/decision";
import type { Location, ProduceType, TimeWindow } from "../types/decision";
import {
  BUYER_DEMAND_STATUSES,
  LISTING_STATUSES,
  OUTCOME_CATEGORIES,
  QUANTITY_KINDS,
  QUANTITY_UNITS,
  type BuyerDemand,
  type BuyerDemandDraft,
  type BuyerDemandStatus,
  type Commitment,
  type CommitmentDraft,
  type CommitmentStatus,
  type Listing,
  type ListingDraft,
  type ListingStatus,
  COMMITMENT_STATUSES,
  type Outcome,
  type OutcomeCategory,
  type OutcomeDraft,
  type Purchase,
  type PurchaseDraft,
  type QuantityKind,
  type QuantityUnit,
} from "./records";
import { failure, success, type DomainResult } from "./result";

type Check<T> = { ok: true; value: T } | { ok: false; message: string };

const LISTING_KEYS = [
  "id",
  "ownerId",
  "commodity",
  "quantity",
  "quantityUnit",
  "quantityKind",
  "location",
  "availabilityWindow",
  "askingPriceKshPerKg",
  "status",
  "createdAt",
  "updatedAt",
] as const;

const LISTING_DRAFT_KEYS = [
  "id",
  "ownerId",
  "commodity",
  "quantity",
  "quantityUnit",
  "quantityKind",
  "location",
  "availabilityWindow",
  "askingPriceKshPerKg",
  "status",
] as const;

const DEMAND_KEYS = [
  "id",
  "buyerId",
  "commodity",
  "requestedQuantity",
  "quantityUnit",
  "preferredLocation",
  "collectionWindow",
  "indicativePriceKshPerKg",
  "status",
  "createdAt",
  "updatedAt",
] as const;

const DEMAND_DRAFT_KEYS = [
  "id",
  "buyerId",
  "commodity",
  "requestedQuantity",
  "quantityUnit",
  "preferredLocation",
  "collectionWindow",
  "indicativePriceKshPerKg",
  "status",
] as const;

const COMMITMENT_KEYS = [
  "id",
  "listingId",
  "buyerDemandId",
  "agreedQuantity",
  "quantityUnit",
  "agreedPriceKshPerKg",
  "expectedFulfilmentDate",
  "status",
  "createdAt",
  "updatedAt",
] as const;

const COMMITMENT_DRAFT_KEYS = [
  "id",
  "listingId",
  "buyerDemandId",
  "agreedQuantity",
  "quantityUnit",
  "agreedPriceKshPerKg",
  "expectedFulfilmentDate",
  "status",
] as const;

const PURCHASE_KEYS = [
  "id",
  "commitmentId",
  "listingId",
  "actualQuantity",
  "quantityUnit",
  "actualPriceKshPerKg",
  "purchaseDate",
  "recordedAt",
] as const;

const PURCHASE_DRAFT_KEYS = [
  "id",
  "commitmentId",
  "listingId",
  "actualQuantity",
  "quantityUnit",
  "actualPriceKshPerKg",
  "purchaseDate",
] as const;

const OUTCOME_KEYS = [
  "id",
  "listingId",
  "commitmentId",
  "purchaseId",
  "category",
  "quantity",
  "quantityUnit",
  "recordedDate",
  "notes",
  "recordedAt",
] as const;

const OUTCOME_DRAFT_KEYS = [
  "id",
  "listingId",
  "commitmentId",
  "purchaseId",
  "category",
  "quantity",
  "quantityUnit",
  "recordedDate",
  "notes",
] as const;

export function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseListing(value: unknown, label = "Listing"): DomainResult<Listing> {
  const record = readShape(value, LISTING_KEYS, [], label);
  if (!record.ok) return record;
  const fields = readListingFields(record.value, label, true);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseListingDraft(value: unknown, label = "Listing"): DomainResult<ListingDraft> {
  const record = readShape(value, LISTING_DRAFT_KEYS, ["id"], label);
  if (!record.ok) return record;
  const fields = readListingFields(record.value, label, false);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseBuyerDemand(value: unknown, label = "Buyer demand"): DomainResult<BuyerDemand> {
  const record = readShape(value, DEMAND_KEYS, [], label);
  if (!record.ok) return record;
  const fields = readDemandFields(record.value, label, true);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseBuyerDemandDraft(value: unknown, label = "Buyer demand"): DomainResult<BuyerDemandDraft> {
  const record = readShape(value, DEMAND_DRAFT_KEYS, ["id"], label);
  if (!record.ok) return record;
  const fields = readDemandFields(record.value, label, false);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseCommitment(value: unknown, label = "Commitment"): DomainResult<Commitment> {
  const record = readShape(value, COMMITMENT_KEYS, [], label);
  if (!record.ok) return record;
  const fields = readCommitmentFields(record.value, label, true);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseCommitmentDraft(value: unknown, label = "Commitment"): DomainResult<CommitmentDraft> {
  const record = readShape(value, COMMITMENT_DRAFT_KEYS, ["id"], label);
  if (!record.ok) return record;
  const fields = readCommitmentFields(record.value, label, false);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parsePurchase(value: unknown, label = "Purchase"): DomainResult<Purchase> {
  const record = readShape(value, PURCHASE_KEYS, [], label);
  if (!record.ok) return record;
  const fields = readPurchaseFields(record.value, label, true);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parsePurchaseDraft(value: unknown, label = "Purchase"): DomainResult<PurchaseDraft> {
  const record = readShape(value, PURCHASE_DRAFT_KEYS, ["id"], label);
  if (!record.ok) return record;
  const fields = readPurchaseFields(record.value, label, false);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseOutcome(value: unknown, label = "Outcome"): DomainResult<Outcome> {
  const record = readShape(value, OUTCOME_KEYS, [], label);
  if (!record.ok) return record;
  const fields = readOutcomeFields(record.value, label, true);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseOutcomeDraft(value: unknown, label = "Outcome"): DomainResult<OutcomeDraft> {
  const record = readShape(value, OUTCOME_DRAFT_KEYS, ["id"], label);
  if (!record.ok) return record;
  const fields = readOutcomeFields(record.value, label, false);
  if (!fields.ok) return fields;
  return success(fields.value);
}

export function parseRecordId(value: unknown): DomainResult<string> {
  const id = readId(value);
  if (!id.ok) return failure("invalid", id.message);
  return success(id.value);
}

function readListingFields(record: Record<string, unknown>, label: string, stored: true): DomainResult<Listing>;
function readListingFields(record: Record<string, unknown>, label: string, stored: false): DomainResult<ListingDraft>;
function readListingFields(
  record: Record<string, unknown>,
  label: string,
  stored: boolean,
): DomainResult<Listing | ListingDraft> {
  const id = readOptionalId(record.id);
  const ownerId = readId(record.ownerId);
  const commodity = readProduce(record.commodity);
  const quantity = readQuantity(record.quantity);
  const quantityUnit = readUnit(record.quantityUnit);
  const quantityKind = readEnum(record.quantityKind, QUANTITY_KINDS, "Choose whether this quantity is available or expected.");
  const location = readLocation(record.location);
  const availabilityWindow = readWindow(record.availabilityWindow, "Choose an availability window.");
  const askingPriceKshPerKg = readPrice(record.askingPriceKshPerKg, false);
  const status = readEnum(record.status, LISTING_STATUSES, "Choose a listing status of draft, open, closed, or withdrawn.");
  const issue = firstIssue([
    id,
    ownerId,
    commodity,
    quantity,
    quantityUnit,
    quantityKind,
    location,
    availabilityWindow,
    askingPriceKshPerKg,
    status,
  ]);
  if (issue) return failure(issue.code, `${label}: ${issue.message}`);
  if (!id.ok || !ownerId.ok || !commodity.ok || !quantity.ok || !quantityUnit.ok || !quantityKind.ok) {
    return failure("invalid", `${label} could not be read.`);
  }
  if (!location.ok || !availabilityWindow.ok || !askingPriceKshPerKg.ok || !status.ok) {
    return failure("invalid", `${label} could not be read.`);
  }

  const body = {
    ...(id.value === undefined ? {} : { id: id.value }),
    ownerId: ownerId.value,
    commodity: commodity.value,
    quantity: quantity.value,
    quantityUnit: quantityUnit.value,
    quantityKind: quantityKind.value as QuantityKind,
    location: location.value,
    availabilityWindow: availabilityWindow.value,
    askingPriceKshPerKg: askingPriceKshPerKg.value,
    status: status.value as ListingStatus,
  };

  if (!stored) return success(body);
  const times = readTimestampPair(record.createdAt, record.updatedAt);
  if (!times.ok) return failure("invalid", `${label}: ${times.message}`);
  if (body.id === undefined) return failure("malformed", `${label} is missing id.`);
  return success({ ...body, id: body.id, createdAt: times.value.createdAt, updatedAt: times.value.updatedAt });
}

function readDemandFields(record: Record<string, unknown>, label: string, stored: true): DomainResult<BuyerDemand>;
function readDemandFields(record: Record<string, unknown>, label: string, stored: false): DomainResult<BuyerDemandDraft>;
function readDemandFields(
  record: Record<string, unknown>,
  label: string,
  stored: boolean,
): DomainResult<BuyerDemand | BuyerDemandDraft> {
  const id = readOptionalId(record.id);
  const buyerId = readId(record.buyerId);
  const commodity = readProduce(record.commodity);
  const requestedQuantity = readQuantity(record.requestedQuantity);
  const quantityUnit = readUnit(record.quantityUnit);
  const preferredLocation = readLocation(record.preferredLocation);
  const collectionWindow = readWindow(record.collectionWindow, "Choose a collection window.");
  const indicativePriceKshPerKg = readPrice(record.indicativePriceKshPerKg, false);
  const status = readEnum(
    record.status,
    BUYER_DEMAND_STATUSES,
    "Choose a demand status of open, closed, or withdrawn.",
  );
  const issue = firstIssue([
    id,
    buyerId,
    commodity,
    requestedQuantity,
    quantityUnit,
    preferredLocation,
    collectionWindow,
    indicativePriceKshPerKg,
    status,
  ]);
  if (issue) return failure(issue.code, `${label}: ${issue.message}`);
  if (!id.ok || !buyerId.ok || !commodity.ok || !requestedQuantity.ok || !quantityUnit.ok) {
    return failure("invalid", `${label} could not be read.`);
  }
  if (!preferredLocation.ok || !collectionWindow.ok || !indicativePriceKshPerKg.ok || !status.ok) {
    return failure("invalid", `${label} could not be read.`);
  }

  const body = {
    ...(id.value === undefined ? {} : { id: id.value }),
    buyerId: buyerId.value,
    commodity: commodity.value,
    requestedQuantity: requestedQuantity.value,
    quantityUnit: quantityUnit.value,
    preferredLocation: preferredLocation.value,
    collectionWindow: collectionWindow.value,
    indicativePriceKshPerKg: indicativePriceKshPerKg.value,
    status: status.value as BuyerDemandStatus,
  };
  if (!stored) return success(body);
  const times = readTimestampPair(record.createdAt, record.updatedAt);
  if (!times.ok) return failure("invalid", `${label}: ${times.message}`);
  if (body.id === undefined) return failure("malformed", `${label} is missing id.`);
  return success({ ...body, id: body.id, createdAt: times.value.createdAt, updatedAt: times.value.updatedAt });
}

function readCommitmentFields(record: Record<string, unknown>, label: string, stored: true): DomainResult<Commitment>;
function readCommitmentFields(record: Record<string, unknown>, label: string, stored: false): DomainResult<CommitmentDraft>;
function readCommitmentFields(
  record: Record<string, unknown>,
  label: string,
  stored: boolean,
): DomainResult<Commitment | CommitmentDraft> {
  const id = readOptionalId(record.id);
  const listingId = readId(record.listingId);
  const buyerDemandId = readId(record.buyerDemandId);
  const agreedQuantity = readQuantity(record.agreedQuantity);
  const quantityUnit = readUnit(record.quantityUnit);
  const agreedPriceKshPerKg = readPrice(record.agreedPriceKshPerKg, true);
  const expectedFulfilmentDate = readDate(record.expectedFulfilmentDate);
  const status = readEnum(
    record.status,
    COMMITMENT_STATUSES,
    "Choose a commitment status of proposed, confirmed, fulfilled, or cancelled.",
  );
  const issue = firstIssue([
    id,
    listingId,
    buyerDemandId,
    agreedQuantity,
    quantityUnit,
    agreedPriceKshPerKg,
    expectedFulfilmentDate,
    status,
  ]);
  if (issue) return failure(issue.code, `${label}: ${issue.message}`);
  if (!id.ok || !listingId.ok || !buyerDemandId.ok || !agreedQuantity.ok || !quantityUnit.ok) {
    return failure("invalid", `${label} could not be read.`);
  }
  if (!agreedPriceKshPerKg.ok || agreedPriceKshPerKg.value === null || !expectedFulfilmentDate.ok || !status.ok) {
    return failure("invalid", `${label} could not be read.`);
  }

  const body = {
    ...(id.value === undefined ? {} : { id: id.value }),
    listingId: listingId.value,
    buyerDemandId: buyerDemandId.value,
    agreedQuantity: agreedQuantity.value,
    quantityUnit: quantityUnit.value,
    agreedPriceKshPerKg: agreedPriceKshPerKg.value,
    expectedFulfilmentDate: expectedFulfilmentDate.value,
    status: status.value as CommitmentStatus,
  };
  if (!stored) return success(body);
  const times = readTimestampPair(record.createdAt, record.updatedAt);
  if (!times.ok) return failure("invalid", `${label}: ${times.message}`);
  if (body.id === undefined) return failure("malformed", `${label} is missing id.`);
  return success({ ...body, id: body.id, createdAt: times.value.createdAt, updatedAt: times.value.updatedAt });
}

function readPurchaseFields(record: Record<string, unknown>, label: string, stored: true): DomainResult<Purchase>;
function readPurchaseFields(record: Record<string, unknown>, label: string, stored: false): DomainResult<PurchaseDraft>;
function readPurchaseFields(
  record: Record<string, unknown>,
  label: string,
  stored: boolean,
): DomainResult<Purchase | PurchaseDraft> {
  const id = readOptionalId(record.id);
  const commitmentId = readId(record.commitmentId);
  const listingId = readId(record.listingId);
  const actualQuantity = readQuantity(record.actualQuantity);
  const quantityUnit = readUnit(record.quantityUnit);
  const actualPriceKshPerKg = readPrice(record.actualPriceKshPerKg, true);
  const purchaseDate = readDate(record.purchaseDate);
  const issue = firstIssue([id, commitmentId, listingId, actualQuantity, quantityUnit, actualPriceKshPerKg, purchaseDate]);
  if (issue) return failure(issue.code, `${label}: ${issue.message}`);
  if (!id.ok || !commitmentId.ok || !listingId.ok || !actualQuantity.ok || !quantityUnit.ok) {
    return failure("invalid", `${label} could not be read.`);
  }
  if (!actualPriceKshPerKg.ok || actualPriceKshPerKg.value === null || !purchaseDate.ok) {
    return failure("invalid", `${label} could not be read.`);
  }

  const body = {
    ...(id.value === undefined ? {} : { id: id.value }),
    commitmentId: commitmentId.value,
    listingId: listingId.value,
    actualQuantity: actualQuantity.value,
    quantityUnit: quantityUnit.value,
    actualPriceKshPerKg: actualPriceKshPerKg.value,
    purchaseDate: purchaseDate.value,
  };
  if (!stored) return success(body);
  const recordedAt = readTimestamp(record.recordedAt);
  if (!recordedAt.ok) return failure("invalid", `${label}: ${recordedAt.message}`);
  if (body.id === undefined) return failure("malformed", `${label} is missing id.`);
  return success({ ...body, id: body.id, recordedAt: recordedAt.value });
}

function readOutcomeFields(record: Record<string, unknown>, label: string, stored: true): DomainResult<Outcome>;
function readOutcomeFields(record: Record<string, unknown>, label: string, stored: false): DomainResult<OutcomeDraft>;
function readOutcomeFields(
  record: Record<string, unknown>,
  label: string,
  stored: boolean,
): DomainResult<Outcome | OutcomeDraft> {
  const id = readOptionalId(record.id);
  const listingId = readId(record.listingId);
  const commitmentId = readNullableId(record.commitmentId);
  const purchaseId = readNullableId(record.purchaseId);
  const category = readEnum(
    record.category,
    OUTCOME_CATEGORIES,
    "Choose an outcome of sold, recovered, spoiled, donated, or disposed.",
  );
  const quantity = readQuantity(record.quantity);
  const quantityUnit = readUnit(record.quantityUnit);
  const recordedDate = readDate(record.recordedDate);
  const notes = readNotes(record.notes);
  const issue = firstIssue([
    id,
    listingId,
    commitmentId,
    purchaseId,
    category,
    quantity,
    quantityUnit,
    recordedDate,
    notes,
  ]);
  if (issue) return failure(issue.code, `${label}: ${issue.message}`);
  if (!id.ok || !listingId.ok || !commitmentId.ok || !purchaseId.ok || !category.ok) {
    return failure("invalid", `${label} could not be read.`);
  }
  if (!quantity.ok || !quantityUnit.ok || !recordedDate.ok || !notes.ok) {
    return failure("invalid", `${label} could not be read.`);
  }

  const body = {
    ...(id.value === undefined ? {} : { id: id.value }),
    listingId: listingId.value,
    commitmentId: commitmentId.value,
    purchaseId: purchaseId.value,
    category: category.value as OutcomeCategory,
    quantity: quantity.value,
    quantityUnit: quantityUnit.value,
    recordedDate: recordedDate.value,
    notes: notes.value,
  };
  if (!stored) return success(body);
  const recordedAt = readTimestamp(record.recordedAt);
  if (!recordedAt.ok) return failure("invalid", `${label}: ${recordedAt.message}`);
  if (body.id === undefined) return failure("malformed", `${label} is missing id.`);
  return success({ ...body, id: body.id, recordedAt: recordedAt.value });
}

function readShape(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[],
  label: string,
): DomainResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return failure("malformed", `${label} must be an object.`);
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown) return failure("malformed", `${label} has unrecognised field ${unknown}.`);
  const missing = allowed.find((key) => !optional.includes(key) && !keys.includes(key));
  if (missing) return failure("malformed", `${label} is missing ${missing}.`);
  return success(value);
}

function firstIssue(checks: Check<unknown>[]): { code: "invalid"; message: string } | null {
  for (const check of checks) {
    if (!check.ok) return { code: "invalid", message: check.message };
  }
  return null;
}

function readOptionalId(value: unknown): Check<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return readId(value);
}

function readNullableId(value: unknown): Check<string | null> {
  if (value === null) return { ok: true, value: null };
  return readId(value);
}

function readId(value: unknown): Check<string> {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    return {
      ok: false,
      message: "Use an id of letters, numbers, hyphens, or underscores, starting with a letter or number.",
    };
  }
  return { ok: true, value };
}

function readProduce(value: unknown): Check<ProduceType> {
  if (!isOneOf(value, PRODUCE_TYPES)) return { ok: false, message: "Choose a commodity." };
  return { ok: true, value };
}

function readLocation(value: unknown): Check<Location> {
  if (!isOneOf(value, LOCATIONS)) return { ok: false, message: "Choose a location." };
  return { ok: true, value };
}

function readWindow(value: unknown, message: string): Check<TimeWindow> {
  if (!isOneOf(value, TIME_WINDOWS)) return { ok: false, message };
  return { ok: true, value };
}

function readUnit(value: unknown): Check<QuantityUnit> {
  if (!isOneOf(value, QUANTITY_UNITS)) return { ok: false, message: "Choose a quantity unit of kg." };
  return { ok: true, value };
}

function readEnum<T extends string>(value: unknown, options: readonly T[], message: string): Check<T> {
  if (!isOneOf(value, options)) return { ok: false, message };
  return { ok: true, value };
}

function readQuantity(value: unknown): Check<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: "Enter a quantity in kilograms." };
  }
  if (value <= 0) return { ok: false, message: "Enter a quantity greater than zero." };
  const milli = Math.round(value * 1000);
  if (!Number.isSafeInteger(milli) || Math.abs(value * 1000 - milli) > 1e-6) {
    return { ok: false, message: "Enter a quantity with at most 3 decimal places." };
  }
  return { ok: true, value: milli / 1000 };
}

function readPrice(value: unknown, required: boolean): Check<number | null> {
  if (value === undefined) {
    return { ok: false, message: "Enter a price in Kenyan shillings per kilogram, or null if there is none." };
  }
  if (value === null && !required) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: "Enter a price in Kenyan shillings per kilogram." };
  }
  if (value <= 0) return { ok: false, message: "Enter a price greater than zero." };
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-6) {
    return { ok: false, message: "Enter a price with at most 2 decimal places." };
  }
  return { ok: true, value: cents / 100 };
}

function readDate(value: unknown): Check<string> {
  if (typeof value !== "string" || !isCalendarDate(value)) {
    return { ok: false, message: "Enter a calendar date as YYYY-MM-DD." };
  }
  return { ok: true, value };
}

function readNotes(value: unknown): Check<string> {
  if (typeof value !== "string") return { ok: false, message: "Enter outcome notes, or leave them blank." };
  if (value.length > 500) return { ok: false, message: "Enter outcome notes of 500 characters or fewer." };
  return { ok: true, value };
}

function readTimestamp(value: unknown): Check<string> {
  if (typeof value !== "string" || !isIsoTimestamp(value)) {
    return { ok: false, message: "Enter a timestamp as YYYY-MM-DDTHH:mm:ss.sssZ." };
  }
  return { ok: true, value };
}

function readTimestampPair(created: unknown, updated: unknown): Check<{ createdAt: string; updatedAt: string }> {
  const createdAt = readTimestamp(created);
  if (!createdAt.ok) return createdAt;
  const updatedAt = readTimestamp(updated);
  if (!updatedAt.ok) return updatedAt;
  if (updatedAt.value < createdAt.value) {
    return { ok: false, message: "The update time must be the same as or later than the creation time." };
  }
  return { ok: true, value: { createdAt: createdAt.value, updatedAt: updatedAt.value } };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
