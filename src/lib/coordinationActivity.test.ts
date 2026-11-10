import { describe, expect, it } from "vitest";
import type { BuyerDemand, Commitment, Listing, Purchase } from "../domain/records";
import {
  agreementBlock,
  confirmedCommitmentCount,
  confirmedQuantityKg,
  heldDemandKg,
  heldListingKg,
  purchasedQuantityKg,
  remainingDemandKg,
  remainingListingKg,
} from "./coordinationActivity";

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "sample-farmer",
    commodity: "Watermelon",
    quantity: 800,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
    createdAt: "2026-11-03T12:00:00.000Z",
    updatedAt: "2026-11-03T12:00:00.000Z",
    ...overrides,
  };
}

function demand(overrides: Partial<BuyerDemand> = {}): BuyerDemand {
  return {
    id: "demand-1",
    buyerId: "sample-buyer",
    commodity: "Watermelon",
    requestedQuantity: 500,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
    createdAt: "2026-11-03T12:00:00.000Z",
    updatedAt: "2026-11-03T12:00:00.000Z",
    ...overrides,
  };
}

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "commitment-1",
    listingId: "listing-1",
    buyerDemandId: "demand-1",
    agreedQuantity: 100,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-04",
    status: "confirmed",
    createdAt: "2026-11-03T12:00:00.000Z",
    updatedAt: "2026-11-03T12:00:00.000Z",
    ...overrides,
  };
}

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: "purchase-1",
    commitmentId: "commitment-1",
    listingId: "listing-1",
    actualQuantity: 30,
    quantityUnit: "kg",
    actualPriceKshPerKg: 40,
    purchaseDate: "2026-11-04",
    recordedAt: "2026-11-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("agreement quantities", () => {
  const commitments = [
    commitment({ id: "confirmed", status: "confirmed", agreedQuantity: 200 }),
    commitment({ id: "proposed", status: "proposed", agreedQuantity: 50 }),
    commitment({ id: "cancelled", status: "cancelled", agreedQuantity: 80 }),
    commitment({ id: "fulfilled", status: "fulfilled", agreedQuantity: 100, buyerDemandId: "demand-2" }),
  ];
  const purchases = [
    purchase({ id: "bought-confirmed", commitmentId: "confirmed", actualQuantity: 30 }),
    purchase({ id: "bought-fulfilled", commitmentId: "fulfilled", actualQuantity: 30 }),
  ];

  it("counts confirmed agreements separately from purchases", () => {
    expect(confirmedCommitmentCount(commitments)).toBe(1);
    expect(confirmedQuantityKg(commitments)).toBe(200);
    expect(confirmedQuantityKg(commitments.filter((item) => item.status !== "confirmed"))).toBeNull();
    expect(purchasedQuantityKg(purchases)).toBe(60);
    expect(purchasedQuantityKg([])).toBeNull();
  });

  it("holds proposed and confirmed quantities, purchased quantity for fulfilled, and nothing for cancelled", () => {
    expect(heldListingKg("listing-1", commitments, purchases)).toBe(280);
    expect(heldDemandKg("demand-1", commitments, purchases)).toBe(250);
    expect(heldDemandKg("demand-2", commitments, purchases)).toBe(30);
    expect(remainingListingKg(listing(), commitments, purchases)).toBe(520);
    expect(remainingDemandKg(demand(), commitments, purchases)).toBe(250);
  });

  it("uses the existing collection-window rule and refuses a different produce", () => {
    expect(agreementBlock(listing(), demand())).toBeNull();
    expect(agreementBlock(listing(), demand({ collectionWindow: "Tomorrow" }))).toContain("Tomorrow");
    expect(agreementBlock(listing({ availabilityWindow: "Tomorrow" }), demand({ collectionWindow: "Tomorrow" }))).toBeNull();
    expect(agreementBlock(listing(), demand({ commodity: "Mango" }))).toContain("Mango");
    expect(agreementBlock(listing({ status: "draft" }), demand())).toContain("open");
  });
});
