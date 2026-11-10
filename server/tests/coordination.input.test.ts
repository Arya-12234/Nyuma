import { describe, expect, it } from "vitest";
import { InvalidRequest } from "../src/auth/identity.js";
import {
  parseAgreementStatus,
  parseAgreementWrite,
  parseDemandPatch,
  parseDemandWrite,
  parseListingPatch,
  parseListingWrite,
  parseOutcomeWrite,
  parsePurchaseWrite,
} from "../src/coordination/input.js";

const listing = {
  commodity: "Watermelon",
  quantity: 10.5,
  quantityUnit: "kg",
  quantityKind: "available",
  location: "Kitui",
  availabilityWindow: "3 hours",
  askingPriceKshPerKg: 40.25,
  status: "draft",
};

describe("coordination input", () => {
  it("rejects a client owner id, an id, and an origin before any record is described", () => {
    expect(() => parseListingWrite({ ...listing, ownerId: "00000000-0000-4000-8000-000000000001" })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, buyerId: "buyer" })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, userId: "user" })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, authUserId: "auth" })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, id: "chosen-id" })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, origin: "demonstration-import" })).toThrow(InvalidRequest);
    expect(() => parseDemandWrite({ ...demand(), buyerId: "00000000-0000-4000-8000-000000000002" })).toThrow(InvalidRequest);
  });

  it("rejects quantities and prices the database would round", () => {
    expect(() => parseListingWrite({ ...listing, quantity: 1.2345 })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, askingPriceKshPerKg: 40.555 })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, quantity: 0 })).toThrow(InvalidRequest);
    expect(() => parseListingWrite({ ...listing, quantity: "10" })).toThrow(InvalidRequest);
    expect(() => parseDemandWrite({ ...demand(), requestedQuantity: 1.2345 })).toThrow(InvalidRequest);
    expect(() => parseDemandWrite({ ...demand(), status: "draft" })).toThrow(InvalidRequest);
  });

  it("accepts gram and cent precision and a null price", () => {
    expect(parseListingWrite({ ...listing, quantity: 1.234, askingPriceKshPerKg: null })).toMatchObject({
      quantity: 1.234,
      askingPriceKshPerKg: null,
      status: "draft",
    });
    expect(parseListingPatch({ quantity: 2 })).toEqual({ quantity: 2 });
    expect(parseDemandPatch({ status: "withdrawn" })).toEqual({ status: "withdrawn" });
  });

  it("rejects party fields and terminal agreement statuses on create", () => {
    const agreement = agreementBody();
    expect(() => parseAgreementWrite({ ...agreement, ownerId: "someone" })).toThrow(InvalidRequest);
    expect(() => parseAgreementWrite({ ...agreement, buyerId: "someone" })).toThrow(InvalidRequest);
    expect(() => parseAgreementWrite({ ...agreement, id: "chosen" })).toThrow(InvalidRequest);
    expect(() => parseAgreementWrite({ ...agreement, status: "fulfilled" })).toThrow(InvalidRequest);
    expect(() => parseAgreementWrite({ ...agreement, status: "cancelled" })).toThrow(InvalidRequest);
    expect(() => parseAgreementWrite({ ...agreement, expectedFulfilmentDate: "2026-02-31" })).toThrow(InvalidRequest);
    expect(() => parseAgreementStatus({ status: "confirmed", listingId: "listing-1" })).toThrow(InvalidRequest);
    expect(() => parsePurchaseWrite({ ...purchaseBody(), listingId: "listing-1" })).toThrow(InvalidRequest);
    expect(() => parsePurchaseWrite({ ...purchaseBody(), buyerId: "someone" })).toThrow(InvalidRequest);
    expect(() => parseOutcomeWrite({ ...outcomeBody(), commitmentId: "commitment-1" })).toThrow(InvalidRequest);
    expect(() => parseOutcomeWrite({ ...outcomeBody(), category: "spoiled", purchaseId: "purchase-1" })).toThrow(InvalidRequest);
    expect(parseAgreementWrite(agreement).status).toBe("confirmed");
    expect(parseAgreementStatus({ status: "cancelled" })).toEqual({ status: "cancelled" });
  });

  it("rejects ownership and commodity changes on update", () => {
    expect(() => parseListingPatch({ ownerId: "someone-else" })).toThrow(InvalidRequest);
    expect(() => parseListingPatch({ commodity: "Mango" })).toThrow(InvalidRequest);
    expect(() => parseListingPatch({ quantityUnit: "kg" })).toThrow(InvalidRequest);
    expect(() => parseListingPatch({})).toThrow(InvalidRequest);
    expect(() => parseDemandPatch({ buyerId: "someone-else" })).toThrow(InvalidRequest);
    expect(() => parseDemandPatch({ commodity: "Mango" })).toThrow(InvalidRequest);
    expect(() => parseDemandPatch({})).toThrow(InvalidRequest);
  });
});

function agreementBody(): Record<string, unknown> {
  return {
    listingId: "listing001",
    buyerDemandId: "demand001",
    agreedQuantity: 8,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-06",
    status: "confirmed",
  };
}

function purchaseBody(): Record<string, unknown> {
  return {
    commitmentId: "commitment001",
    actualQuantity: 4,
    quantityUnit: "kg",
    actualPriceKshPerKg: 41,
    purchaseDate: "2026-11-06",
  };
}

function outcomeBody(): Record<string, unknown> {
  return {
    listingId: "listing001",
    category: "sold",
    quantity: 4,
    quantityUnit: "kg",
    recordedDate: "2026-11-06",
    notes: "",
    purchaseId: null,
  };
}

function demand(): Record<string, unknown> {
  return {
    commodity: "Watermelon",
    requestedQuantity: 8,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 42,
    status: "open",
  };
}
