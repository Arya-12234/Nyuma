import type { Location, ProduceType, TimeWindow } from "../types/decision";

export const QUANTITY_UNITS = ["kg"] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const QUANTITY_KINDS = ["available", "expected"] as const;
export type QuantityKind = (typeof QUANTITY_KINDS)[number];

export const LISTING_STATUSES = ["draft", "open", "closed", "withdrawn"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const BUYER_DEMAND_STATUSES = ["open", "closed", "withdrawn"] as const;
export type BuyerDemandStatus = (typeof BUYER_DEMAND_STATUSES)[number];

export const COMMITMENT_STATUSES = ["proposed", "confirmed", "fulfilled", "cancelled"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const OUTCOME_CATEGORIES = ["sold", "recovered", "spoiled", "donated", "disposed"] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

export interface Listing {
  id: string;
  ownerId: string;
  commodity: ProduceType;
  quantity: number;
  quantityUnit: QuantityUnit;
  quantityKind: QuantityKind;
  location: Location;
  availabilityWindow: TimeWindow;
  askingPriceKshPerKg: number | null;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListingDraft {
  id?: string;
  ownerId: string;
  commodity: ProduceType;
  quantity: number;
  quantityUnit: QuantityUnit;
  quantityKind: QuantityKind;
  location: Location;
  availabilityWindow: TimeWindow;
  askingPriceKshPerKg: number | null;
  status: ListingStatus;
}

export interface ListingPatch {
  quantity?: number;
  quantityKind?: QuantityKind;
  location?: Location;
  availabilityWindow?: TimeWindow;
  askingPriceKshPerKg?: number | null;
  status?: ListingStatus;
}

export interface BuyerDemand {
  id: string;
  buyerId: string;
  commodity: ProduceType;
  requestedQuantity: number;
  quantityUnit: QuantityUnit;
  preferredLocation: Location;
  collectionWindow: TimeWindow;
  indicativePriceKshPerKg: number | null;
  status: BuyerDemandStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerDemandDraft {
  id?: string;
  buyerId: string;
  commodity: ProduceType;
  requestedQuantity: number;
  quantityUnit: QuantityUnit;
  preferredLocation: Location;
  collectionWindow: TimeWindow;
  indicativePriceKshPerKg: number | null;
  status: BuyerDemandStatus;
}

export interface BuyerDemandPatch {
  requestedQuantity?: number;
  preferredLocation?: Location;
  collectionWindow?: TimeWindow;
  indicativePriceKshPerKg?: number | null;
  status?: BuyerDemandStatus;
}

export interface Commitment {
  id: string;
  listingId: string;
  buyerDemandId: string;
  agreedQuantity: number;
  quantityUnit: QuantityUnit;
  agreedPriceKshPerKg: number;
  expectedFulfilmentDate: string;
  status: CommitmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentDraft {
  id?: string;
  listingId: string;
  buyerDemandId: string;
  agreedQuantity: number;
  quantityUnit: QuantityUnit;
  agreedPriceKshPerKg: number;
  expectedFulfilmentDate: string;
  status: CommitmentStatus;
}

export interface CommitmentPatch {
  status: CommitmentStatus;
}

export interface Purchase {
  id: string;
  commitmentId: string;
  listingId: string;
  actualQuantity: number;
  quantityUnit: QuantityUnit;
  actualPriceKshPerKg: number;
  purchaseDate: string;
  recordedAt: string;
}

export interface PurchaseDraft {
  id?: string;
  commitmentId: string;
  listingId: string;
  actualQuantity: number;
  quantityUnit: QuantityUnit;
  actualPriceKshPerKg: number;
  purchaseDate: string;
}

export interface Outcome {
  id: string;
  listingId: string;
  commitmentId: string | null;
  purchaseId: string | null;
  category: OutcomeCategory;
  quantity: number;
  quantityUnit: QuantityUnit;
  recordedDate: string;
  /** Null when the API withholds notes from a buyer. Sample records keep a string. */
  notes: string | null;
  recordedAt: string;
}

export interface OutcomeDraft {
  id?: string;
  listingId: string;
  commitmentId: string | null;
  purchaseId: string | null;
  category: OutcomeCategory;
  quantity: number;
  quantityUnit: QuantityUnit;
  recordedDate: string;
  notes: string;
}

/** Version 1 of the coordination document. Scenario saves are not stored here. */
export interface CoordinationDocumentV1 {
  version: 1;
  listings: Listing[];
  buyerDemands: BuyerDemand[];
  commitments: Commitment[];
  purchases: Purchase[];
  outcomes: Outcome[];
}
