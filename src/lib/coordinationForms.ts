import type {
  BuyerDemandDraft,
  BuyerDemandStatus,
  CommitmentDraft,
  ListingDraft,
  ListingStatus,
  OutcomeDraft,
  PurchaseDraft,
} from "../domain/records";
import { failure, type DomainResult } from "../domain/result";
import { parseBuyerDemandDraft, parseCommitmentDraft, parseListingDraft, parseOutcomeDraft, parsePurchaseDraft } from "../domain/validateRecords";

export interface ListingFormValues {
  commodity: string;
  quantity: string;
  quantityKind: string;
  location: string;
  availabilityWindow: string;
  askingPrice: string;
}

export interface DemandFormValues {
  commodity: string;
  quantity: string;
  location: string;
  collectionWindow: string;
  indicativePrice: string;
}

export const EMPTY_LISTING_FORM: ListingFormValues = {
  commodity: "",
  quantity: "",
  quantityKind: "",
  location: "",
  availabilityWindow: "",
  askingPrice: "",
};

export const EMPTY_DEMAND_FORM: DemandFormValues = {
  commodity: "",
  quantity: "",
  location: "",
  collectionWindow: "",
  indicativePrice: "",
};

/** Build a listing draft. The owner id is supplied by the signed-in account, never by the form. */
export function listingDraftFromForm(
  ownerId: string,
  values: ListingFormValues,
  status: ListingStatus,
): DomainResult<ListingDraft> {
  return parseListingDraft({
    ownerId,
    commodity: values.commodity,
    quantity: numericField(values.quantity),
    quantityUnit: "kg",
    quantityKind: values.quantityKind,
    location: values.location,
    availabilityWindow: values.availabilityWindow,
    askingPriceKshPerKg: values.askingPrice.trim() === "" ? null : numericField(values.askingPrice),
    status,
  });
}

/** Build a demand draft. The buyer id is supplied by the signed-in account. */
export function demandDraftFromForm(
  buyerId: string,
  values: DemandFormValues,
  status: BuyerDemandStatus,
): DomainResult<BuyerDemandDraft> {
  return parseBuyerDemandDraft({
    buyerId,
    commodity: values.commodity,
    requestedQuantity: numericField(values.quantity),
    quantityUnit: "kg",
    preferredLocation: values.location,
    collectionWindow: values.collectionWindow,
    indicativePriceKshPerKg: values.indicativePrice.trim() === "" ? null : numericField(values.indicativePrice),
    status,
  });
}

export interface CommitmentFormValues {
  listingId: string;
  buyerDemandId: string;
  quantity: string;
  price: string;
  expectedFulfilmentDate: string;
}

export interface PurchaseFormValues {
  quantity: string;
  price: string;
  purchaseDate: string;
}

export const EMPTY_COMMITMENT_FORM: CommitmentFormValues = {
  listingId: "",
  buyerDemandId: "",
  quantity: "",
  price: "",
  expectedFulfilmentDate: "",
};

export const EMPTY_PURCHASE_FORM: PurchaseFormValues = {
  quantity: "",
  price: "",
  purchaseDate: "",
};

/** The signed-in account is not a field. The listing and requirement are existing records. */
export function commitmentDraftFromForm(values: CommitmentFormValues): DomainResult<CommitmentDraft> {
  return parseCommitmentDraft({
    listingId: values.listingId,
    buyerDemandId: values.buyerDemandId,
    agreedQuantity: numericField(values.quantity),
    quantityUnit: "kg",
    agreedPriceKshPerKg: numericField(values.price),
    expectedFulfilmentDate: values.expectedFulfilmentDate.trim(),
    status: "confirmed",
  });
}

/** The listing id comes from the saved agreement, never from the form. */
export function purchaseDraftFromForm(
  commitmentId: string,
  listingId: string,
  values: PurchaseFormValues,
): DomainResult<PurchaseDraft> {
  return parsePurchaseDraft({
    commitmentId,
    listingId,
    actualQuantity: numericField(values.quantity),
    quantityUnit: "kg",
    actualPriceKshPerKg: numericField(values.price),
    purchaseDate: values.purchaseDate.trim(),
  });
}

export function fieldForCommitmentMessage(message: string): keyof CommitmentFormValues | null {
  const text = message.toLowerCase();
  if (text.includes("price")) return "price";
  if (text.includes("quantity") || text.includes("kilogram") || text.includes("left to agree")) return "quantity";
  if (text.includes("date") || text.includes("calendar")) return "expectedFulfilmentDate";
  if (text.includes("listing")) return "listingId";
  if (text.includes("requirement") || text.includes("demand") || text.includes("window") || text.includes("produce")) {
    return "buyerDemandId";
  }
  return null;
}

export interface OutcomeFormValues {
  listingId: string;
  category: string;
  saleKind: string;
  purchaseId: string;
  quantity: string;
  recordedDate: string;
  notes: string;
}

export const EMPTY_OUTCOME_FORM: OutcomeFormValues = {
  listingId: "",
  category: "",
  saleKind: "",
  purchaseId: "",
  quantity: "",
  recordedDate: "",
  notes: "",
};

/** Purchase and agreement ids are supplied by the workflow, never typed as a new sale. */
export function outcomeDraftFromForm(
  values: OutcomeFormValues,
  purchaseId: string | null,
  commitmentId: string | null,
): DomainResult<OutcomeDraft> {
  return parseOutcomeDraft({
    listingId: values.listingId,
    commitmentId,
    purchaseId,
    category: values.category,
    quantity: numericField(values.quantity),
    quantityUnit: "kg",
    recordedDate: values.recordedDate.trim(),
    notes: values.notes.trim(),
  });
}

export function fieldForOutcomeMessage(message: string): keyof OutcomeFormValues | null {
  const text = message.toLowerCase();
  if (text.includes("whether this sale") || text.includes("saved purchase") || text.includes("outside nyuma")) return "saleKind";
  if (text.includes("what happened") || text.includes("outcome of")) return "category";
  if (text.includes("quantity") || text.includes("kilogram") || text.includes("unaccounted") || text.includes("already counted")) {
    return "quantity";
  }
  if (text.includes("date") || text.includes("calendar")) return "recordedDate";
  if (text.includes("note")) return "notes";
  if (text.includes("listing")) return "listingId";
  if (text.includes("purchase")) return "purchaseId";
  return null;
}

export function fieldForPurchaseMessage(message: string): keyof PurchaseFormValues | null {
  const text = message.toLowerCase();
  if (text.includes("price")) return "price";
  if (
    text.includes("quantity") ||
    text.includes("kilogram") ||
    text.includes("remaining") ||
    text.includes("left to purchase")
  ) {
    return "quantity";
  }
  if (text.includes("date") || text.includes("calendar")) return "purchaseDate";
  return null;
}

export function fieldForListingMessage(message: string): keyof ListingFormValues | null {
  if (message.toLowerCase().includes("price")) return "askingPrice";
  if (message.toLowerCase().includes("quantity")) return "quantity";
  if (message.toLowerCase().includes("location")) return "location";
  if (message.toLowerCase().includes("window") || message.toLowerCase().includes("collect")) return "availabilityWindow";
  if (message.toLowerCase().includes("available") || message.toLowerCase().includes("expected")) return "quantityKind";
  if (message.toLowerCase().includes("produce") || message.toLowerCase().includes("commodity")) return "commodity";
  return null;
}

export function fieldForDemandMessage(message: string): keyof DemandFormValues | null {
  if (message.toLowerCase().includes("price")) return "indicativePrice";
  if (message.toLowerCase().includes("quantity")) return "quantity";
  if (message.toLowerCase().includes("location")) return "location";
  if (message.toLowerCase().includes("window") || message.toLowerCase().includes("collect")) return "collectionWindow";
  if (message.toLowerCase().includes("produce") || message.toLowerCase().includes("commodity")) return "commodity";
  return null;
}

function numericField(raw: string): unknown {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : trimmed;
}

export function refused(message: string): DomainResult<never> {
  return failure("conflict", message);
}

export function savedMessage(kind: "listing" | "requirement"): string {
  return kind === "listing" ? "Listing saved." : "Purchasing requirement saved.";
}
