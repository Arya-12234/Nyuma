import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_FORM } from "../data/scenarioData";
import { SCENARIO_STORAGE_KEY, loadScenario, saveScenario, type KeyValueStore } from "../lib/scenarioStorage";
import type { PersistedScenario } from "../types/decision";
import type { ProduceType } from "../types/decision";
import {
  COORDINATION_MIGRATIONS,
  COORDINATION_SCHEMA_VERSION,
  COORDINATION_STORAGE_KEY,
  emptyCoordinationDocument,
  parseCoordinationDocument,
  type CoordinationKeyValueStore,
} from "./coordinationDocument";
import {
  createFixedClock,
  createInMemoryCoordinationRepository,
  createLocalCoordinationRepository,
  createSequentialIdGenerator,
  createSteppedClock,
  type CoordinationRepository,
  type RepositoryDeps,
} from "./coordinationRepository";
import type {
  BuyerDemandDraft,
  CommitmentDraft,
  Listing,
  ListingDraft,
  ListingPatch,
  ListingStatus,
  Outcome,
  OutcomeDraft,
  Purchase,
  PurchaseDraft,
} from "./records";
import type { DomainErrorCode, DomainResult } from "./result";
import { checkDocumentInvariants } from "./relationships";

const STAMP = "2026-11-03T12:00:00.000Z";

function repositoryDeps(): RepositoryDeps {
  return { clock: createFixedClock(STAMP), ids: createSequentialIdGenerator() };
}

function isolatedStore(): CoordinationKeyValueStore & { raw: () => string | null } {
  let value: string | null = null;
  return {
    getItem(key) {
      return key === COORDINATION_STORAGE_KEY ? value : null;
    },
    setItem(key, next) {
      if (key !== COORDINATION_STORAGE_KEY) throw new Error(`unexpected key ${key}`);
      value = next;
    },
    raw: () => value,
  };
}

const subjects = [
  {
    name: "in-memory repository",
    make: () => createInMemoryCoordinationRepository(repositoryDeps()),
  },
  {
    name: "local repository",
    make: () => createLocalCoordinationRepository(isolatedStore(), repositoryDeps()),
  },
];

function listingDraft(overrides: Partial<ListingDraft> = {}): ListingDraft {
  return {
    ownerId: "owner-1",
    commodity: "Watermelon",
    quantity: 800,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
    ...overrides,
  };
}

function demandDraft(overrides: Partial<BuyerDemandDraft> = {}): BuyerDemandDraft {
  return {
    buyerId: "buyer-1",
    commodity: "Watermelon",
    requestedQuantity: 800,
    quantityUnit: "kg",
    preferredLocation: "Nairobi",
    collectionWindow: "Today",
    indicativePriceKshPerKg: 40,
    status: "open",
    ...overrides,
  };
}

function commitmentDraft(listingId: string, buyerDemandId: string, overrides: Partial<CommitmentDraft> = {}): CommitmentDraft {
  return {
    listingId,
    buyerDemandId,
    agreedQuantity: 300,
    quantityUnit: "kg",
    agreedPriceKshPerKg: 40,
    expectedFulfilmentDate: "2026-11-04",
    status: "confirmed",
    ...overrides,
  };
}

function purchaseDraft(commitmentId: string, listingId: string, overrides: Partial<PurchaseDraft> = {}): PurchaseDraft {
  return {
    commitmentId,
    listingId,
    actualQuantity: 100,
    quantityUnit: "kg",
    actualPriceKshPerKg: 40,
    purchaseDate: "2026-11-04",
    ...overrides,
  };
}

function outcomeDraft(listingId: string, overrides: Partial<OutcomeDraft> = {}): OutcomeDraft {
  return {
    listingId,
    commitmentId: null,
    purchaseId: null,
    category: "spoiled",
    quantity: 10,
    quantityUnit: "kg",
    recordedDate: "2026-11-04",
    notes: "",
    ...overrides,
  };
}

function listingRecord(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "listing-1",
    ownerId: "owner-1",
    commodity: "Watermelon",
    quantity: 800,
    quantityUnit: "kg",
    quantityKind: "available",
    location: "Kitui",
    availabilityWindow: "3 hours",
    askingPriceKshPerKg: 40,
    status: "open",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function expectFailure(result: DomainResult<unknown>, message: RegExp, code?: DomainErrorCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toMatch(message);
  if (code) expect(result.code).toBe(code);
}

async function openLoad(repository: CoordinationRepository, listing: Partial<ListingDraft> = {}, demand: Partial<BuyerDemandDraft> = {}) {
  const createdListing = await repository.createListing(listingDraft(listing));
  const createdDemand = await repository.createBuyerDemand(demandDraft(demand));
  if (!createdListing.ok || !createdDemand.ok) {
    throw new Error("fixture records were rejected");
  }
  return { listing: createdListing.value, demand: createdDemand.value };
}

describe("domain record types", () => {
  it("keeps statuses, prices, and links explicit", () => {
    expectTypeOf<Listing["status"]>().toEqualTypeOf<ListingStatus>();
    expectTypeOf<Listing["commodity"]>().toEqualTypeOf<ProduceType>();
    expectTypeOf<Listing["askingPriceKshPerKg"]>().toEqualTypeOf<number | null>();
    expectTypeOf<keyof Purchase>().toEqualTypeOf<
      | "id"
      | "commitmentId"
      | "listingId"
      | "actualQuantity"
      | "quantityUnit"
      | "actualPriceKshPerKg"
      | "purchaseDate"
      | "recordedAt"
    >();
    expectTypeOf<keyof Outcome>().toEqualTypeOf<
      | "id"
      | "listingId"
      | "commitmentId"
      | "purchaseId"
      | "category"
      | "quantity"
      | "quantityUnit"
      | "recordedDate"
      | "notes"
      | "recordedAt"
    >();
    expect(COORDINATION_SCHEMA_VERSION).toBe(1);
    expect(COORDINATION_MIGRATIONS).toEqual([]);
    expect(COORDINATION_STORAGE_KEY).not.toBe(SCENARIO_STORAGE_KEY);
  });

  it("accepts the repository contract without a delete operation", () => {
    const repository = createInMemoryCoordinationRepository(repositoryDeps());
    const listed: Promise<DomainResult<readonly Listing[]>> = repository.listListings();
    expect(listed).toBeInstanceOf(Promise);
    expect("deleteListing" in repository).toBe(false);
  });
});

describe.each(subjects)("$name", ({ make }) => {
  it("rejects invalid quantities and prices and accepts gram and cent precision", async () => {
    const repository = make();
    expectFailure(await repository.createListing(listingDraft({ quantity: 0 })), /greater than zero/);
    expectFailure(await repository.createListing(listingDraft({ quantity: -5 })), /greater than zero/);
    expectFailure(await repository.createListing(listingDraft({ quantity: 1.2345 })), /3 decimal places/);
    expectFailure(await repository.createListing(listingDraft({ askingPriceKshPerKg: 0 })), /greater than zero/);
    expectFailure(await repository.createListing(listingDraft({ askingPriceKshPerKg: 40.555 })), /2 decimal places/);
    expectFailure(
      await repository.createListing(listingDraft({ commodity: "Pineapple" as ListingDraft["commodity"] })),
      /commodity/,
    );

    const created = await repository.createListing(
      listingDraft({ quantity: 0.125, askingPriceKshPerKg: 40.5, commodity: "Mango", location: "Other" }),
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.quantity).toBe(0.125);
      expect(created.value.askingPriceKshPerKg).toBe(40.5);
      expect(created.value.createdAt).toBe(STAMP);
      expect(created.value.updatedAt).toBe(STAMP);
    }
    const cleared = await repository.createListing(listingDraft({ askingPriceKshPerKg: null, id: "no-price" }));
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.askingPriceKshPerKg).toBeNull();
  });

  it("assigns unique ids and rejects an id that is already used or unrecognised fields", async () => {
    const repository = make();
    const first = await repository.createListing(listingDraft());
    const second = await repository.createListing(listingDraft());
    expect(first.ok && first.value.id).toBe("listing-1");
    expect(second.ok && second.value.id).toBe("listing-2");

    const supplied = await repository.createListing(listingDraft({ id: "kitui-load" }));
    expect(supplied.ok && supplied.value.id).toBe("kitui-load");
    const duplicate = await repository.createBuyerDemand(demandDraft({ id: "kitui-load" }));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("conflict");

    const extra = await repository.createListing({ ...listingDraft(), notes: "ripe" } as ListingDraft);
    expectFailure(extra, /notes/);
    const listed = await repository.listListings();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(3);
  });

  it("keeps commitment, purchase, and outcome quantities inside the related records", async () => {
    const repository = make();
    const { listing, demand } = await openLoad(repository);

    expectFailure(await repository.recordCommitment(commitmentDraft("missing", demand.id)), /No listing/, "not-found");
    const smallDemand = await repository.createBuyerDemand(demandDraft({ requestedQuantity: 100, id: "demand-small" }));
    expect(smallDemand.ok).toBe(true);
    expectFailure(
      await repository.recordCommitment(commitmentDraft(listing.id, "demand-small", { agreedQuantity: 150 })),
      /requested/,
    );

    const draftListing = await repository.createListing(listingDraft({ status: "draft", id: "draft-load" }));
    expect(draftListing.ok).toBe(true);
    expectFailure(await repository.recordCommitment(commitmentDraft("draft-load", demand.id)), /listing is open/);

    const mango = await repository.createBuyerDemand(demandDraft({ commodity: "Mango", id: "demand-mango" }));
    expect(mango.ok).toBe(true);
    expectFailure(await repository.recordCommitment(commitmentDraft(listing.id, "demand-mango")), /Mango/);

    const proposed = await repository.recordCommitment(
      commitmentDraft(listing.id, demand.id, { agreedQuantity: 800, status: "proposed", id: "commit-a" }),
    );
    expect(proposed.ok).toBe(true);
    expectFailure(
      await repository.recordCommitment(commitmentDraft(listing.id, demand.id, { agreedQuantity: 1 })),
      /listing quantity/,
    );
    expectFailure(await repository.recordPurchase(purchaseDraft("commit-a", listing.id)), /confirmed commitment/);
    expectFailure(await repository.updateCommitment("commit-a", { status: "fulfilled" }), /cannot become fulfilled/);

    const confirmed = await repository.updateCommitment("commit-a", { status: "confirmed" });
    expect(confirmed.ok).toBe(true);
    expectFailure(await repository.updateCommitment("commit-a", { status: "confirmed" }), /already confirmed/);

    const otherListing = await repository.createListing(listingDraft({ id: "other-load" }));
    expect(otherListing.ok).toBe(true);
    expectFailure(
      await repository.recordPurchase(purchaseDraft("commit-a", "other-load", { actualQuantity: 50 })),
      /but commitment/,
    );

    expectFailure(await repository.recordPurchase(purchaseDraft("commit-a", listing.id, { actualQuantity: 801 })), /agreed/);
    const purchases = await repository.listPurchases();
    expect(purchases.ok).toBe(true);
    if (purchases.ok) expect(purchases.value).toEqual([]);

    const purchase = await repository.recordPurchase(purchaseDraft("commit-a", listing.id, { actualQuantity: 100, id: "purchase-1" }));
    expect(purchase.ok).toBe(true);
    const stillConfirmed = await repository.getCommitment("commit-a");
    expect(stillConfirmed.ok).toBe(true);
    if (stillConfirmed.ok) expect(stillConfirmed.value.status).toBe("confirmed");
    expectFailure(await repository.updateCommitment("commit-a", { status: "cancelled" }), /recorded purchase/);

    const fulfilled = await repository.updateCommitment("commit-a", { status: "fulfilled" });
    expect(fulfilled.ok).toBe(true);
    const secondDemand = await repository.createBuyerDemand(demandDraft({ requestedQuantity: 700, id: "demand-rest" }));
    expect(secondDemand.ok).toBe(true);
    const rest = await repository.recordCommitment(
      commitmentDraft(listing.id, "demand-rest", { agreedQuantity: 700, status: "proposed" }),
    );
    expect(rest.ok).toBe(true);
    expectFailure(
      await repository.recordCommitment(commitmentDraft(listing.id, "demand-rest", { agreedQuantity: 1 })),
      /listing quantity/,
    );

    const sold = await repository.recordOutcome(
      outcomeDraft(listing.id, { category: "sold", quantity: 100, purchaseId: "purchase-1", commitmentId: "commit-a", notes: "Collected." }),
    );
    expect(sold.ok).toBe(true);
    expectFailure(
      await repository.recordOutcome(outcomeDraft(listing.id, { category: "spoiled", purchaseId: "purchase-1", quantity: 1 })),
      /sold category/,
    );
    expectFailure(await repository.recordOutcome(outcomeDraft(listing.id, { quantity: 701 })), /Outcomes on listing/);
    expectFailure(await repository.getListing("missing-load"), /missing-load/, "not-found");
  });

  it("updates a listing without rewriting its identity, and returns copies", async () => {
    const repository = make();
    const created = await repository.createListing(listingDraft());
    if (!created.ok) throw new Error("listing was rejected");

    expectFailure(await repository.updateListing(created.value.id, {}), /Nothing on this listing/);
    expectFailure(await repository.updateListing(created.value.id, null as unknown as ListingPatch), /must be an object/);
    expectFailure(await repository.updateListing(created.value.id, { ownerId: "owner-2" } as ListingPatch), /ownerId/);

    const updated = await repository.updateListing(created.value.id, { askingPriceKshPerKg: null, quantityKind: "expected" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.ownerId).toBe("owner-1");
      expect(updated.value.askingPriceKshPerKg).toBeNull();
      expect(updated.value.quantityKind).toBe("expected");
    }

    const listed = await repository.listListings();
    if (!listed.ok) throw new Error("list failed");
    (listed.value as Listing[])[0].quantity = 1;
    const again = await repository.listListings();
    expect(again.ok && again.value[0].quantity).toBe(800);
  });

  it("rejects a commitment date that is not a real calendar day", async () => {
    const repository = make();
    const { listing, demand } = await openLoad(repository);
    const result = await repository.recordCommitment(
      commitmentDraft(listing.id, demand.id, { expectedFulfilmentDate: "2026-02-31" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/calendar date/);
  });
});

describe("coordination document", () => {
  it("refuses another schema version without reading or discarding its records", () => {
    const parsed = parseCoordinationDocument({ version: 2, listings: "not-a-list" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("unsupported-version");
      expect(parsed.message).toMatch(/version 2/);
      expect(parsed.message).toMatch(/left unchanged/);
      expect(parsed.message).not.toMatch(/must be a list/);
    }
    expect(parseCoordinationDocument({ version: 0 }, COORDINATION_MIGRATIONS).ok).toBe(false);
  });

  it("runs a migration once and still rejects a document that does not land on version 1", () => {
    const migrated = parseCoordinationDocument({ version: 0 }, [
      { fromVersion: 0, migrate: () => emptyCoordinationDocument() },
    ]);
    expect(migrated.ok).toBe(true);

    const thrown = parseCoordinationDocument({ version: 0 }, [
      {
        fromVersion: 0,
        migrate() {
          throw new Error("nope");
        },
      },
    ]);
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.message).toMatch(/could not be migrated/);

    const stillNew = parseCoordinationDocument({ version: 0 }, [{ fromVersion: 0, migrate: () => ({ version: 9 }) }]);
    expect(stillNew.ok).toBe(false);
    if (!stillNew.ok) expect(stillNew.code).toBe("unsupported-version");
  });

  it("rejects duplicate ids, broken relationships, unknown fields, and impossible timestamps", () => {
    const duplicate = emptyCoordinationDocument();
    duplicate.listings = [listingRecord({ id: "same" }), listingRecord({ id: "same" })];
    const duplicateResult = parseCoordinationDocument(duplicate);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.code).toBe("conflict");

    const purchaseWithoutCommitment = emptyCoordinationDocument();
    purchaseWithoutCommitment.listings = [listingRecord()];
    purchaseWithoutCommitment.purchases = [
      {
        id: "purchase-1",
        commitmentId: "missing-commitment",
        listingId: "listing-1",
        actualQuantity: 10,
        quantityUnit: "kg",
        actualPriceKshPerKg: 40,
        purchaseDate: "2026-11-04",
        recordedAt: STAMP,
      },
    ];
    const broken = parseCoordinationDocument(purchaseWithoutCommitment);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe("relationship");

    const unknownField = {
      ...emptyCoordinationDocument(),
      listings: [listingRecord()],
      matches: [],
    };
    expect(parseCoordinationDocument(unknownField).ok).toBe(false);

    const earlyUpdate = emptyCoordinationDocument();
    earlyUpdate.listings = [listingRecord({ createdAt: "2026-11-03T12:00:01.000Z", updatedAt: STAMP })];
    const times = parseCoordinationDocument(earlyUpdate);
    expect(times.ok).toBe(false);
    if (!times.ok) expect(times.message).toMatch(/update time/);

    const textQuantity = emptyCoordinationDocument();
    textQuantity.listings = [{ ...listingRecord(), quantity: "800" } as unknown as Listing];
    expect(parseCoordinationDocument(textQuantity).ok).toBe(false);

    const closed = emptyCoordinationDocument();
    closed.listings = [listingRecord({ status: "closed", quantity: 100 })];
    closed.buyerDemands = [
      {
        id: "demand-1",
        buyerId: "buyer-1",
        commodity: "Watermelon",
        requestedQuantity: 100,
        quantityUnit: "kg",
        preferredLocation: "Nairobi",
        collectionWindow: "Today",
        indicativePriceKshPerKg: null,
        status: "closed",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ];
    closed.commitments = [
      {
        id: "commitment-1",
        listingId: "listing-1",
        buyerDemandId: "demand-1",
        agreedQuantity: 100,
        quantityUnit: "kg",
        agreedPriceKshPerKg: 38,
        expectedFulfilmentDate: "2026-11-04",
        status: "confirmed",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ];
    expect(parseCoordinationDocument(closed).ok).toBe(true);
  });

  it("rejects a stored commitment that uses a different unit", () => {
    const document = emptyCoordinationDocument();
    document.listings = [listingRecord({ quantity: 10 })];
    document.buyerDemands = [
      {
        id: "demand-1",
        buyerId: "buyer-1",
        commodity: "Watermelon",
        requestedQuantity: 10,
        quantityUnit: "kg",
        preferredLocation: "Kitui",
        collectionWindow: "Today",
        indicativePriceKshPerKg: 40,
        status: "open",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ];
    document.commitments = [
      {
        id: "commitment-1",
        listingId: "listing-1",
        buyerDemandId: "demand-1",
        agreedQuantity: 10,
        quantityUnit: "kg",
        agreedPriceKshPerKg: 40,
        expectedFulfilmentDate: "2026-11-04",
        status: "proposed",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ];
    document.commitments[0].quantityUnit = "crate" as Listing["quantityUnit"];
    const result = checkDocumentInvariants(document, "store");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/quantity unit/);
  });
});

describe("local coordination store", () => {
  it("reloads records and leaves an invalid document byte for byte", async () => {
    const store = isolatedStore();
    const first = createLocalCoordinationRepository(store, repositoryDeps());
    const created = await first.createListing(listingDraft({ id: "load-1" }));
    expect(created.ok).toBe(true);
    const second = createLocalCoordinationRepository(store, repositoryDeps());
    const listed = await second.listListings();
    expect(listed.ok && listed.value.map((listing) => listing.id)).toEqual(["load-1"]);

    const broken = isolatedStore();
    const original = "{";
    broken.setItem(COORDINATION_STORAGE_KEY, original);
    const blocked = createLocalCoordinationRepository(broken, repositoryDeps());
    const refused = await blocked.createListing(listingDraft());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/left unchanged/);
    expect(broken.raw()).toBe(original);

    const future = isolatedStore();
    const version2 = JSON.stringify({ version: 2, listings: [] });
    future.setItem(COORDINATION_STORAGE_KEY, version2);
    const unread = await createLocalCoordinationRepository(future, repositoryDeps()).listListings();
    expect(unread.ok).toBe(false);
    if (!unread.ok) expect(unread.code).toBe("unsupported-version");
    expect(future.raw()).toBe(version2);
  });

  it("rolls back the repository when local storage refuses the write", async () => {
    let value: string | null = null;
    let failWrite = true;
    const store: CoordinationKeyValueStore = {
      getItem: () => value,
      setItem: (_key, next) => {
        if (failWrite) throw new Error("blocked");
        value = next;
      },
    };
    const repository = createLocalCoordinationRepository(store, repositoryDeps());
    const failed = await repository.createListing(listingDraft());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toMatch(/blocked local storage/);
    const afterFailure = await repository.listListings();
    expect(afterFailure.ok).toBe(true);
    if (afterFailure.ok) expect(afterFailure.value).toEqual([]);
    failWrite = false;
    const created = await repository.createListing(listingDraft());
    expect(created.ok && created.value.id).toBe("listing-2");
    expect(value).toContain('"listing-2"');
  });

  it("does not mix coordination records with the scenario save", async () => {
    const data = new Map<string, string>();
    const store: CoordinationKeyValueStore & KeyValueStore = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    const saved: PersistedScenario = {
      version: 1,
      scenario: { ...DEFAULT_FORM },
      selectedBuyerIds: ["city-market-traders"],
    };
    expect(saveScenario(saved, store).ok).toBe(true);
    const scenarioJson = store.getItem(SCENARIO_STORAGE_KEY);
    const repository = createLocalCoordinationRepository(store, repositoryDeps());
    expect((await repository.createListing(listingDraft({ id: "coord-1" }))).ok).toBe(true);

    expect(store.getItem(SCENARIO_STORAGE_KEY)).toBe(scenarioJson);
    expect(store.getItem(COORDINATION_STORAGE_KEY)).toContain("coord-1");
    expect(store.getItem(COORDINATION_STORAGE_KEY)).not.toContain("selectedBuyerIds");
    const loaded = loadScenario(["nairobi-fresh-produce", "city-market-traders", "green-basket-wholesale"], store);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data).toEqual(saved);
  });

  it("refuses a seed that would require dropping a record", () => {
    const document = emptyCoordinationDocument();
    document.listings = [listingRecord({ id: "same" }), listingRecord({ id: "same" })];
    expect(() => createInMemoryCoordinationRepository(repositoryDeps(), document)).toThrow(/same/);
  });
});

describe("clock", () => {
  it("moves the update time forward without changing the creation time", async () => {
    const repository = createInMemoryCoordinationRepository({
      clock: createSteppedClock(STAMP),
      ids: createSequentialIdGenerator(),
    });
    const created = await repository.createListing(listingDraft());
    if (!created.ok) throw new Error("listing was rejected");
    const updated = await repository.updateListing(created.value.id, { askingPriceKshPerKg: 41 });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.createdAt).toBe(STAMP);
      expect(updated.value.updatedAt > updated.value.createdAt).toBe(true);
      expect(updated.value.askingPriceKshPerKg).toBe(41);
    }
  });
});
