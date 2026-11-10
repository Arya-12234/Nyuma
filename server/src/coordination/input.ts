import { InvalidRequest } from "../auth/identity.js";

const commodities = ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const;
const locations = ["Kitui", "Nairobi", "Other"] as const;
const windows = ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const;
const listingStatuses = ["draft", "open", "closed", "withdrawn"] as const;
const demandStatuses = ["open", "closed", "withdrawn"] as const;

export type Commodity = (typeof commodities)[number];
export type LocationName = (typeof locations)[number];
export type TimeWindowName = (typeof windows)[number];
export type ListingStatusName = (typeof listingStatuses)[number];
export type DemandStatusName = (typeof demandStatuses)[number];

export interface ListingWrite {
  commodity: Commodity;
  quantity: number;
  quantityKind: "available" | "expected";
  location: LocationName;
  availabilityWindow: TimeWindowName;
  askingPriceKshPerKg: number | null;
  status: ListingStatusName;
}

export interface ListingPatch {
  quantity?: number;
  quantityKind?: "available" | "expected";
  location?: LocationName;
  availabilityWindow?: TimeWindowName;
  askingPriceKshPerKg?: number | null;
  status?: ListingStatusName;
}

export interface DemandWrite {
  commodity: Commodity;
  requestedQuantity: number;
  preferredLocation: LocationName;
  collectionWindow: TimeWindowName;
  indicativePriceKshPerKg: number | null;
  status: DemandStatusName;
}

export interface DemandPatch {
  requestedQuantity?: number;
  preferredLocation?: LocationName;
  collectionWindow?: TimeWindowName;
  indicativePriceKshPerKg?: number | null;
  status?: DemandStatusName;
}

const listingCreateKeys = [
  "commodity",
  "quantity",
  "quantityUnit",
  "quantityKind",
  "location",
  "availabilityWindow",
  "askingPriceKshPerKg",
  "status",
] as const;

const listingPatchKeys = ["quantity", "quantityKind", "location", "availabilityWindow", "askingPriceKshPerKg", "status"] as const;

const demandCreateKeys = [
  "commodity",
  "requestedQuantity",
  "quantityUnit",
  "preferredLocation",
  "collectionWindow",
  "indicativePriceKshPerKg",
  "status",
] as const;

const demandPatchKeys = ["requestedQuantity", "preferredLocation", "collectionWindow", "indicativePriceKshPerKg", "status"] as const;

const agreementStatuses = ["proposed", "confirmed"] as const;
const agreementStatusChanges = ["proposed", "confirmed", "fulfilled", "cancelled"] as const;
const outcomeCategories = ["sold", "recovered", "spoiled", "donated", "disposed"] as const;

export type AgreementCreateStatus = (typeof agreementStatuses)[number];
export type AgreementStatusName = (typeof agreementStatusChanges)[number];
export type OutcomeCategoryName = (typeof outcomeCategories)[number];

export interface AgreementWrite {
  listingId: string;
  buyerDemandId: string;
  agreedQuantity: number;
  agreedPriceKshPerKg: number;
  expectedFulfilmentDate: string;
  status: AgreementCreateStatus;
}

export interface AgreementStatusPatch {
  status: AgreementStatusName;
}

export interface PurchaseWrite {
  commitmentId: string;
  actualQuantity: number;
  actualPriceKshPerKg: number;
  purchaseDate: string;
}

export interface OutcomeWrite {
  listingId: string;
  category: OutcomeCategoryName;
  quantity: number;
  recordedDate: string;
  notes: string;
  purchaseId: string | null;
}

const agreementCreateKeys = [
  "listingId",
  "buyerDemandId",
  "agreedQuantity",
  "quantityUnit",
  "agreedPriceKshPerKg",
  "expectedFulfilmentDate",
  "status",
] as const;

const purchaseCreateKeys = ["commitmentId", "actualQuantity", "quantityUnit", "actualPriceKshPerKg", "purchaseDate"] as const;

const outcomeCreateKeys = ["listingId", "category", "quantity", "quantityUnit", "recordedDate", "notes", "purchaseId"] as const;

export function parseListingWrite(body: Record<string, unknown>): ListingWrite {
  requireKeys(body, listingCreateKeys, listingCreateKeys);
  if (body.quantityUnit !== "kg") throw new InvalidRequest();
  return {
    commodity: oneOf(body.commodity, commodities),
    quantity: readQuantity(body.quantity),
    quantityKind: oneOf(body.quantityKind, ["available", "expected"] as const),
    location: oneOf(body.location, locations),
    availabilityWindow: oneOf(body.availabilityWindow, windows),
    askingPriceKshPerKg: readPrice(body.askingPriceKshPerKg),
    status: oneOf(body.status, listingStatuses),
  };
}

export function parseListingPatch(body: Record<string, unknown>): ListingPatch {
  requireKeys(body, listingPatchKeys, []);
  if (Object.keys(body).length === 0) throw new InvalidRequest();
  const patch: ListingPatch = {};
  if ("quantity" in body) patch.quantity = readQuantity(body.quantity);
  if ("quantityKind" in body) patch.quantityKind = oneOf(body.quantityKind, ["available", "expected"] as const);
  if ("location" in body) patch.location = oneOf(body.location, locations);
  if ("availabilityWindow" in body) patch.availabilityWindow = oneOf(body.availabilityWindow, windows);
  if ("askingPriceKshPerKg" in body) patch.askingPriceKshPerKg = readPrice(body.askingPriceKshPerKg);
  if ("status" in body) patch.status = oneOf(body.status, listingStatuses);
  return patch;
}

export function parseDemandWrite(body: Record<string, unknown>): DemandWrite {
  requireKeys(body, demandCreateKeys, demandCreateKeys);
  if (body.quantityUnit !== "kg") throw new InvalidRequest();
  return {
    commodity: oneOf(body.commodity, commodities),
    requestedQuantity: readQuantity(body.requestedQuantity),
    preferredLocation: oneOf(body.preferredLocation, locations),
    collectionWindow: oneOf(body.collectionWindow, windows),
    indicativePriceKshPerKg: readPrice(body.indicativePriceKshPerKg),
    status: oneOf(body.status, demandStatuses),
  };
}

export function parseDemandPatch(body: Record<string, unknown>): DemandPatch {
  requireKeys(body, demandPatchKeys, []);
  if (Object.keys(body).length === 0) throw new InvalidRequest();
  const patch: DemandPatch = {};
  if ("requestedQuantity" in body) patch.requestedQuantity = readQuantity(body.requestedQuantity);
  if ("preferredLocation" in body) patch.preferredLocation = oneOf(body.preferredLocation, locations);
  if ("collectionWindow" in body) patch.collectionWindow = oneOf(body.collectionWindow, windows);
  if ("indicativePriceKshPerKg" in body) patch.indicativePriceKshPerKg = readPrice(body.indicativePriceKshPerKg);
  if ("status" in body) patch.status = oneOf(body.status, demandStatuses);
  return patch;
}

export function parseAgreementWrite(body: Record<string, unknown>): AgreementWrite {
  requireKeys(body, agreementCreateKeys, agreementCreateKeys);
  if (body.quantityUnit !== "kg") throw new InvalidRequest();
  return {
    listingId: recordId(body.listingId),
    buyerDemandId: recordId(body.buyerDemandId),
    agreedQuantity: readQuantity(body.agreedQuantity),
    agreedPriceKshPerKg: readRequiredPrice(body.agreedPriceKshPerKg),
    expectedFulfilmentDate: readCalendarDate(body.expectedFulfilmentDate),
    status: oneOf(body.status, agreementStatuses),
  };
}

export function parseAgreementStatus(body: Record<string, unknown>): AgreementStatusPatch {
  requireKeys(body, ["status"], ["status"]);
  return { status: oneOf(body.status, agreementStatusChanges) };
}

export function parsePurchaseWrite(body: Record<string, unknown>): PurchaseWrite {
  requireKeys(body, purchaseCreateKeys, purchaseCreateKeys);
  if (body.quantityUnit !== "kg") throw new InvalidRequest();
  return {
    commitmentId: recordId(body.commitmentId),
    actualQuantity: readQuantity(body.actualQuantity),
    actualPriceKshPerKg: readRequiredPrice(body.actualPriceKshPerKg),
    purchaseDate: readCalendarDate(body.purchaseDate),
  };
}

export function parseOutcomeWrite(body: Record<string, unknown>): OutcomeWrite {
  requireKeys(body, outcomeCreateKeys, outcomeCreateKeys);
  if (body.quantityUnit !== "kg") throw new InvalidRequest();
  const purchaseId = body.purchaseId === null ? null : recordId(body.purchaseId);
  const category = oneOf(body.category, outcomeCategories);
  if (purchaseId !== null && category !== "sold") throw new InvalidRequest();
  return {
    listingId: recordId(body.listingId),
    category,
    quantity: readQuantity(body.quantity),
    recordedDate: readCalendarDate(body.recordedDate),
    notes: readNotes(body.notes),
    purchaseId,
  };
}

export function recordId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new InvalidRequest();
  return value;
}

function readCalendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidRequest();
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new InvalidRequest();
  return value;
}

function readRequiredPrice(value: unknown): number {
  const price = readPrice(value);
  if (price === null) throw new InvalidRequest();
  return price;
}

function readNotes(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new InvalidRequest();
  return value;
}

function requireKeys(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) throw new InvalidRequest();
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) throw new InvalidRequest();
  }
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value === "string" && options.includes(value as T)) return value as T;
  throw new InvalidRequest();
}

function readQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new InvalidRequest();
  const milli = Math.round(value * 1000);
  if (!Number.isSafeInteger(milli) || Math.abs(value * 1000 - milli) > 1e-6) throw new InvalidRequest();
  const maximum = 99_999_999_999.999;
  if (milli / 1000 > maximum) throw new InvalidRequest();
  return milli / 1000;
}

function readPrice(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new InvalidRequest();
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-6) throw new InvalidRequest();
  if (cents / 100 > 99_999_999_999.99) throw new InvalidRequest();
  return cents / 100;
}
