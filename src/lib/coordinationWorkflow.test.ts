import { describe, expect, it } from "vitest";
import { COORDINATION_STORAGE_KEY } from "../domain/coordinationDocument";
import {
  createInMemoryCoordinationRepository,
  createLocalCoordinationRepository,
  createSequentialIdGenerator,
  createSteppedClock,
  type CoordinationRepository,
} from "../domain/coordinationRepository";
import type { CoordinationKeyValueStore } from "../domain/coordinationDocument";
import { signIn } from "./auth";
import type { CommitmentFormValues, DemandFormValues, ListingFormValues, OutcomeFormValues, PurchaseFormValues } from "./coordinationForms";
import {
  cancelCommitmentRecord,
  confirmProposedCommitment,
  createDemandRecord,
  createListingRecord,
  recordConfirmedCommitment,
  recordOutcomeRecord,
  recordPurchaseRecord,
  updateDemandRecord,
  updateListingRecord,
} from "./coordinationWorkflow";
import { SAMPLE_USERS, type SampleSession } from "./sampleUsers";

const listing: ListingFormValues = {
  commodity: "Watermelon",
  quantity: "800",
  quantityKind: "expected",
  location: "Kitui",
  availabilityWindow: "3 hours",
  askingPrice: "40",
};

const demand: DemandFormValues = {
  commodity: "Watermelon",
  quantity: "300",
  location: "Nairobi",
  collectionWindow: "Today",
  indicativePrice: "42",
};

function sessionFor(email: string): SampleSession {
  const account = SAMPLE_USERS.find((item) => item.email === email);
  if (!account) throw new Error(`missing sample account ${email}`);
  const result = signIn(account.email, account.password);
  if (!result.ok) throw new Error(`sample sign-in failed for ${email}`);
  return result.user;
}

function memoryRepository(): CoordinationRepository {
  return createInMemoryCoordinationRepository({
    clock: createSteppedClock("2026-11-03T12:00:00.000Z"),
    ids: createSequentialIdGenerator(),
  });
}

function localRepository(store: CoordinationKeyValueStore): CoordinationRepository {
  return createLocalCoordinationRepository(store, {
    clock: createSteppedClock("2026-11-03T12:00:00.000Z"),
    ids: createSequentialIdGenerator(),
  });
}

function memoryStore(): CoordinationKeyValueStore & { failWrites: boolean; raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  const store = {
    raw,
    failWrites: false,
    getItem: (key: string) => (key in raw ? raw[key] : null),
    setItem: (key: string, value: string) => {
      if (store.failWrites) throw new Error("blocked");
      raw[key] = value;
    },
  };
  return store;
}

describe("produce listings and buyer demand", () => {
  it("lets a farmer save an expected harvest without treating it as available produce", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const repository = memoryRepository();
    const created = await createListingRecord(repository, farmer, listing, "draft");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.ownerId).toBe("sample-farmer");
    expect(created.value.quantityKind).toBe("expected");
    expect(created.value.status).toBe("draft");
    expect(created.value.commodity).toBe("Watermelon");
    expect(created.value.quantity).toBe(800);
  });

  it("lets a trader open an available listing and keeps the owner on the signed-in account", async () => {
    const trader = sessionFor("winnie@nyuma.ke");
    const repository = memoryRepository();
    const created = await createListingRecord(repository, trader, { ...listing, quantityKind: "available" }, "open");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.ownerId).toBe("sample-trader");
    expect(created.value.quantityKind).toBe("available");
    expect(created.value.status).toBe("open");
  });

  it("lets a buyer submit and edit a requirement, and refuses other roles", async () => {
    const buyer = sessionFor("buyer@nyuma.ke");
    const farmer = sessionFor("farmer@nyuma.ke");
    const repository = memoryRepository();
    expect((await createDemandRecord(repository, farmer, demand)).ok).toBe(false);
    expect((await createListingRecord(repository, buyer, listing, "open")).ok).toBe(false);
    const created = await createDemandRecord(repository, buyer, demand);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.buyerId).toBe("sample-buyer");
    expect(created.value.status).toBe("open");
    const edited = await updateDemandRecord(repository, buyer, created.value.id, { ...demand, quantity: "250" }, "open");
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.requestedQuantity).toBe(250);
    expect(edited.value.commodity).toBe("Watermelon");
    const listings = await repository.listListings();
    expect(listings.ok && listings.value).toEqual([]);
  });

  it("edits the owner's listing and refuses another account", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const trader = sessionFor("winnie@nyuma.ke");
    const repository = memoryRepository();
    const created = await createListingRecord(repository, farmer, listing, "draft");
    if (!created.ok) throw new Error(created.message);
    const edited = await updateListingRecord(repository, farmer, created.value.id, { ...listing, quantity: "750" }, "draft");
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.quantity).toBe(750);
    expect(edited.value.commodity).toBe("Watermelon");
    expect(edited.value.ownerId).toBe("sample-farmer");
    const stolen = await updateListingRecord(repository, trader, created.value.id, { ...listing, quantity: "1" }, "draft");
    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.message).toContain("another sample account");
    const stored = await repository.getListing(created.value.id);
    expect(stored.ok && stored.value.quantity).toBe(750);
  });

  it("rejects invalid quantities and prices before saving", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const repository = memoryRepository();
    const zero = await createListingRecord(repository, farmer, { ...listing, quantity: "0" }, "draft");
    const precise = await createListingRecord(repository, farmer, { ...listing, quantity: "1.2345" }, "draft");
    const price = await createListingRecord(repository, farmer, { ...listing, askingPrice: "0" }, "draft");
    expect(zero.ok).toBe(false);
    expect(precise.ok).toBe(false);
    expect(price.ok).toBe(false);
    if (!zero.ok) expect(zero.message).toContain("greater than zero");
    if (!precise.ok) expect(precise.message).toContain("3 decimal");
    if (!price.ok) expect(price.message).toContain("greater than zero");
    const stored = await repository.listListings();
    expect(stored.ok && stored.value).toEqual([]);
  });

  it("opens a draft, then closes or withdraws it, and leaves closed records unchanged", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const repository = memoryRepository();
    const draft = await createListingRecord(repository, farmer, listing, "draft");
    if (!draft.ok) throw new Error(draft.message);
    const opened = await updateListingRecord(repository, farmer, draft.value.id, listing, "open");
    expect(opened.ok && opened.value.status).toBe("open");
    const closed = await updateListingRecord(repository, farmer, draft.value.id, listing, "closed");
    expect(closed.ok && closed.value.status).toBe("closed");
    const reopened = await updateListingRecord(repository, farmer, draft.value.id, { ...listing, quantity: "100" }, "open");
    expect(reopened.ok).toBe(false);
    const stored = await repository.getListing(draft.value.id);
    expect(stored.ok && stored.value.status).toBe("closed");
    expect(stored.ok && stored.value.quantity).toBe(800);

    const another = await createListingRecord(repository, farmer, listing, "open");
    if (!another.ok) throw new Error(another.message);
    const withdrawn = await updateListingRecord(repository, farmer, another.value.id, listing, "withdrawn");
    expect(withdrawn.ok && withdrawn.value.status).toBe("withdrawn");
  });

  it("closes and withdraws buyer demand without turning it into a commitment", async () => {
    const buyer = sessionFor("buyer@nyuma.ke");
    const repository = memoryRepository();
    const created = await createDemandRecord(repository, buyer, demand);
    if (!created.ok) throw new Error(created.message);
    const closed = await updateDemandRecord(repository, buyer, created.value.id, demand, "closed");
    expect(closed.ok && closed.value.status).toBe("closed");
    const changed = await updateDemandRecord(repository, buyer, created.value.id, { ...demand, quantity: "10" }, "open");
    expect(changed.ok).toBe(false);
    const next = await createDemandRecord(repository, buyer, demand);
    if (!next.ok) throw new Error(next.message);
    const withdrawn = await updateDemandRecord(repository, buyer, next.value.id, demand, "withdrawn");
    expect(withdrawn.ok && withdrawn.value.status).toBe("withdrawn");
    const commitments = await repository.listCommitments();
    expect(commitments.ok && commitments.value).toEqual([]);
  });

  it("keeps listings after a new repository reads the same browser storage", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const store = memoryStore();
    const first = localRepository(store);
    const created = await createListingRecord(first, farmer, listing, "open");
    expect(created.ok).toBe(true);
    const second = localRepository(store);
    const listed = await second.listListings();
    expect(listed.ok).toBe(true);
    if (!listed.ok || !created.ok) return;
    expect(listed.value.map((item) => item.id)).toEqual([created.value.id]);
    expect(listed.value[0]?.quantityKind).toBe("expected");
    expect(store.raw[COORDINATION_STORAGE_KEY]).toContain("sample-farmer");
  });

  it("reports a storage failure and leaves the previous listing in place", async () => {
    const farmer = sessionFor("farmer@nyuma.ke");
    const store = memoryStore();
    const repository = localRepository(store);
    const created = await createListingRecord(repository, farmer, listing, "draft");
    if (!created.ok) throw new Error(created.message);
    store.failWrites = true;
    const failed = await updateListingRecord(repository, farmer, created.value.id, { ...listing, quantity: "900" }, "draft");
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.message).toContain("blocked local storage");
    const reloaded = localRepository(store);
    const listed = await reloaded.listListings();
    expect(listed.ok && listed.value[0]?.quantity).toBe(800);
  });
});

const agreement = (listingId: string, demandId: string, quantity = "200", price = "40"): CommitmentFormValues => ({
  listingId,
  buyerDemandId: demandId,
  quantity,
  price,
  expectedFulfilmentDate: "2026-11-04",
});

const purchase = (quantity = "50", price = "40"): PurchaseFormValues => ({
  quantity,
  price,
  purchaseDate: "2026-11-04",
});

async function openPair(
  repository: CoordinationRepository,
  listingValues: ListingFormValues = { ...listing, quantityKind: "available" },
  demandValues: DemandFormValues = demand,
) {
  const farmer = sessionFor("farmer@nyuma.ke");
  const buyer = sessionFor("buyer@nyuma.ke");
  const savedListing = await createListingRecord(repository, farmer, listingValues, "open");
  const savedDemand = await createDemandRecord(repository, buyer, demandValues);
  if (!savedListing.ok) throw new Error(savedListing.message);
  if (!savedDemand.ok) throw new Error(savedDemand.message);
  return { farmer, buyer, listing: savedListing.value, demand: savedDemand.value };
}

describe("commitments and purchases", () => {
  it("lets the listing owner or the buyer record a confirmed agreement", async () => {
    const repository = memoryRepository();
    const { farmer, buyer, listing: savedListing, demand: savedDemand } = await openPair(repository);
    const trader = sessionFor("winnie@nyuma.ke");
    const admin = sessionFor("admin@nyuma.ke");
    expect((await recordConfirmedCommitment(repository, admin, agreement(savedListing.id, savedDemand.id))).ok).toBe(false);
    const byFarmer = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, savedDemand.id, "100"));
    expect(byFarmer.ok).toBe(true);
    if (!byFarmer.ok) return;
    expect(byFarmer.value.status).toBe("confirmed");
    expect(byFarmer.value.listingId).toBe(savedListing.id);
    expect(byFarmer.value.buyerDemandId).toBe(savedDemand.id);
    expect(byFarmer.value.agreedQuantity).toBe(100);
    expect(byFarmer.value.createdAt).toBe(byFarmer.value.updatedAt);
    const byBuyer = await recordConfirmedCommitment(repository, buyer, agreement(savedListing.id, savedDemand.id, "50", "41"));
    expect(byBuyer.ok).toBe(true);
    expect((await recordConfirmedCommitment(repository, trader, agreement(savedListing.id, savedDemand.id, "10"))).ok).toBe(false);
    const storedListing = await repository.getListing(savedListing.id);
    const storedDemand = await repository.getBuyerDemand(savedDemand.id);
    expect(storedListing.ok && storedListing.value.quantity).toBe(800);
    expect(storedListing.ok && storedListing.value.status).toBe("open");
    expect(storedDemand.ok && storedDemand.value.requestedQuantity).toBe(300);
    expect(storedDemand.ok && storedDemand.value.status).toBe("open");
  });

  it("rejects a missing record, a different produce, and an incompatible collection window", async () => {
    const repository = memoryRepository();
    const { farmer, listing: savedListing, demand: savedDemand } = await openPair(repository);
    const missing = await recordConfirmedCommitment(repository, farmer, agreement("missing-listing", savedDemand.id));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("listing");
    const mango = await createDemandRecord(repository, sessionFor("buyer@nyuma.ke"), { ...demand, commodity: "Mango" });
    if (!mango.ok) throw new Error(mango.message);
    const mismatch = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, mango.value.id));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.message).toContain("Mango");
    const tomorrow = await createDemandRecord(repository, sessionFor("buyer@nyuma.ke"), { ...demand, collectionWindow: "Tomorrow" });
    if (!tomorrow.ok) throw new Error(tomorrow.message);
    const window = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, tomorrow.value.id));
    expect(window.ok).toBe(false);
    if (!window.ok) expect(window.message).toContain("Tomorrow");
    const commitments = await repository.listCommitments();
    expect(commitments.ok && commitments.value).toEqual([]);
  });

  it("keeps several agreements inside the listing and the remaining requirement", async () => {
    const repository = memoryRepository();
    const farmer = sessionFor("farmer@nyuma.ke");
    const buyer = sessionFor("buyer@nyuma.ke");
    const savedListing = await createListingRecord(repository, farmer, { ...listing, quantity: "800", quantityKind: "available" }, "open");
    const firstDemand = await createDemandRecord(repository, buyer, { ...demand, quantity: "500" });
    const secondDemand = await createDemandRecord(repository, buyer, { ...demand, quantity: "500" });
    if (!savedListing.ok || !firstDemand.ok || !secondDemand.ok) throw new Error("setup failed");
    const first = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.value.id, firstDemand.value.id, "300"));
    expect(first.ok).toBe(true);
    const overDemand = await recordConfirmedCommitment(repository, buyer, agreement(savedListing.value.id, firstDemand.value.id, "250"));
    expect(overDemand.ok).toBe(false);
    if (!overDemand.ok) expect(overDemand.message).toContain("requirement");
    const overListing = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.value.id, secondDemand.value.id, "600"));
    expect(overListing.ok).toBe(false);
    if (!overListing.ok) expect(overListing.message).toContain("listing");
    const fitted = await recordConfirmedCommitment(repository, buyer, agreement(savedListing.value.id, secondDemand.value.id, "200"));
    expect(fitted.ok).toBe(true);
    const zero = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.value.id, secondDemand.value.id, "0"));
    const price = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.value.id, secondDemand.value.id, "10", "0"));
    expect(zero.ok).toBe(false);
    expect(price.ok).toBe(false);
  });

  it("drops a cancelled agreement from the quantity still available to agree", async () => {
    const repository = memoryRepository();
    const { farmer, listing: savedListing, demand: savedDemand } = await openPair(
      repository,
      { ...listing, quantity: "800", quantityKind: "available" },
      { ...demand, quantity: "800" },
    );
    const created = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, savedDemand.id, "800"));
    if (!created.ok) throw new Error(created.message);
    const blocked = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, savedDemand.id, "1"));
    expect(blocked.ok).toBe(false);
    const cancelled = await cancelCommitmentRecord(repository, farmer, created.value.id);
    expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
    const again = await recordConfirmedCommitment(repository, sessionFor("buyer@nyuma.ke"), agreement(savedListing.id, savedDemand.id, "800"));
    expect(again.ok).toBe(true);
    const trader = sessionFor("winnie@nyuma.ke");
    expect((await cancelCommitmentRecord(repository, trader, created.value.id)).ok).toBe(false);
    expect((await cancelCommitmentRecord(repository, sessionFor("admin@nyuma.ke"), created.value.id)).ok).toBe(false);
  });

  it("records purchases only against a confirmed agreement and only up to the quantity left", async () => {
    const repository = memoryRepository();
    const { farmer, buyer, listing: savedListing, demand: savedDemand } = await openPair(repository);
    const proposed = await repository.recordCommitment({
      listingId: savedListing.id,
      buyerDemandId: savedDemand.id,
      agreedQuantity: 100,
      quantityUnit: "kg",
      agreedPriceKshPerKg: 40,
      expectedFulfilmentDate: "2026-11-04",
      status: "proposed",
    });
    if (!proposed.ok) throw new Error(proposed.message);
    const tooSoon = await recordPurchaseRecord(repository, buyer, proposed.value.id, purchase("40"));
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.message).toContain("confirmed");
    const confirmed = await confirmProposedCommitment(repository, farmer, proposed.value.id);
    expect(confirmed.ok && confirmed.value.status).toBe("confirmed");
    const traderListing = await createListingRecord(
      repository,
      sessionFor("winnie@nyuma.ke"),
      { ...listing, commodity: "Mango", quantityKind: "available" },
      "open",
    );
    if (!traderListing.ok) throw new Error(traderListing.message);
    expect((await recordPurchaseRecord(repository, sessionFor("winnie@nyuma.ke"), proposed.value.id, purchase("10"))).ok).toBe(false);
    expect((await recordPurchaseRecord(repository, sessionFor("admin@nyuma.ke"), proposed.value.id, purchase("10"))).ok).toBe(false);
    const first = await recordPurchaseRecord(repository, farmer, proposed.value.id, purchase("60"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.listingId).toBe(savedListing.id);
    expect(first.value.commitmentId).toBe(proposed.value.id);
    const second = await recordPurchaseRecord(repository, buyer, proposed.value.id, purchase("50"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("left to purchase");
    const rest = await recordPurchaseRecord(repository, buyer, proposed.value.id, purchase("40", "39"));
    expect(rest.ok).toBe(true);
    const still = await repository.getCommitment(proposed.value.id);
    expect(still.ok && still.value.status).toBe("confirmed");
    const bought = await repository.listPurchases();
    expect(bought.ok && bought.value.reduce((total, item) => total + item.actualQuantity, 0)).toBe(100);
    expect((await cancelCommitmentRecord(repository, farmer, proposed.value.id)).ok).toBe(false);
    const listingAfter = await repository.getListing(savedListing.id);
    expect(listingAfter.ok && listingAfter.value.status).toBe("open");
    expect(listingAfter.ok && listingAfter.value.quantity).toBe(800);
  });

  it("keeps agreements and purchases after a new repository reads the same browser storage", async () => {
    const store = memoryStore();
    const first = localRepository(store);
    const { farmer, listing: savedListing, demand: savedDemand } = await openPair(first);
    const created = await recordConfirmedCommitment(first, farmer, agreement(savedListing.id, savedDemand.id, "80"));
    if (!created.ok) throw new Error(created.message);
    const bought = await recordPurchaseRecord(first, sessionFor("buyer@nyuma.ke"), created.value.id, purchase("25"));
    expect(bought.ok).toBe(true);
    const second = localRepository(store);
    const commitments = await second.listCommitments();
    const purchases = await second.listPurchases();
    const listings = await second.listListings();
    expect(commitments.ok && commitments.value.map((item) => item.id)).toEqual([created.value.id]);
    expect(purchases.ok && purchases.value).toHaveLength(1);
    expect(listings.ok && listings.value[0]?.id).toBe(savedListing.id);
    expect(listings.ok && listings.value[0]?.quantity).toBe(800);
  });

  it("reports a storage failure and leaves the earlier agreement unwritten", async () => {
    const store = memoryStore();
    const repository = localRepository(store);
    const { farmer, listing: savedListing, demand: savedDemand } = await openPair(repository);
    store.failWrites = true;
    const failed = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, savedDemand.id));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toContain("blocked local storage");
    const reloaded = localRepository(store);
    const commitments = await reloaded.listCommitments();
    const listings = await reloaded.listListings();
    expect(commitments.ok && commitments.value).toEqual([]);
    expect(listings.ok && listings.value[0]?.quantity).toBe(800);
    expect(listings.ok && listings.value[0]?.id).toBe(savedListing.id);
  });
});

const outcome = (patch: Partial<OutcomeFormValues> = {}): OutcomeFormValues => ({
  listingId: "",
  category: "spoiled",
  saleKind: "",
  purchaseId: "",
  quantity: "10",
  recordedDate: "2026-11-06",
  notes: "",
  ...patch,
});

describe("produce outcomes", () => {
  it("records each category without creating a purchase or changing the listing", async () => {
    const repository = memoryRepository();
    const farmer = sessionFor("farmer@nyuma.ke");
    const saved = await createListingRecord(repository, farmer, { ...listing, quantity: "100", quantityKind: "available" }, "open");
    if (!saved.ok) throw new Error(saved.message);
    for (const category of ["sold", "recovered", "spoiled", "donated", "disposed"] as const) {
      const values = outcome({
        listingId: saved.value.id,
        category,
        saleKind: category === "sold" ? "external" : "",
        quantity: "10",
        recordedDate: `2026-11-0${["sold", "recovered", "spoiled", "donated", "disposed"].indexOf(category) + 1}`,
        notes: category,
      });
      const recorded = await recordOutcomeRecord(repository, farmer, values);
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      expect(recorded.value.category).toBe(category);
      expect(recorded.value.quantity).toBe(10);
      expect(recorded.value.purchaseId).toBeNull();
    }
    const purchases = await repository.listPurchases();
    const listings = await repository.getListing(saved.value.id);
    expect(purchases.ok && purchases.value).toEqual([]);
    expect(listings.ok && listings.value.quantity).toBe(100);
    expect(listings.ok && listings.value.quantityKind).toBe("available");
  });

  it("rejects a missing listing, another owner's listing, and buyer or administrator recording", async () => {
    const repository = memoryRepository();
    const { farmer, buyer, listing: savedListing } = await openPair(repository);
    const trader = sessionFor("winnie@nyuma.ke");
    const admin = sessionFor("admin@nyuma.ke");
    const missing = await recordOutcomeRecord(repository, farmer, outcome({ listingId: "missing-listing" }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("listing");
    expect((await recordOutcomeRecord(repository, trader, outcome({ listingId: savedListing.id }))).ok).toBe(false);
    expect((await recordOutcomeRecord(repository, buyer, outcome({ listingId: savedListing.id }))).ok).toBe(false);
    expect((await recordOutcomeRecord(repository, admin, outcome({ listingId: savedListing.id }))).ok).toBe(false);
    const outcomes = await repository.listOutcomes();
    expect(outcomes.ok && outcomes.value).toEqual([]);
  });

  it("links a sold outcome to a purchase without counting those kilograms twice", async () => {
    const repository = memoryRepository();
    const { farmer, listing: savedListing, demand: savedDemand } = await openPair(
      repository,
      { ...listing, quantity: "100", quantityKind: "available" },
      { ...demand, quantity: "100" },
    );
    const agreed = await recordConfirmedCommitment(repository, farmer, agreement(savedListing.id, savedDemand.id, "80"));
    if (!agreed.ok) throw new Error(agreed.message);
    const bought = await recordPurchaseRecord(repository, farmer, agreed.value.id, purchase("60"));
    if (!bought.ok) throw new Error(bought.message);
    const before = await repository.listPurchases();
    const linked = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: savedListing.id,
      category: "sold",
      saleKind: "purchase",
      purchaseId: bought.value.id,
      quantity: "60",
      notes: "Collected",
    }));
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.value.purchaseId).toBe(bought.value.id);
    expect(linked.value.commitmentId).toBe(agreed.value.id);
    const overlap = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: savedListing.id,
      category: "recovered",
      quantity: "50",
      recordedDate: "2026-11-07",
    }));
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.message).toContain("unaccounted");
    const again = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: savedListing.id,
      category: "sold",
      saleKind: "purchase",
      purchaseId: bought.value.id,
      quantity: "60",
      notes: "Collected",
    }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toContain("already");
    const outside = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: savedListing.id,
      category: "sold",
      saleKind: "external",
      quantity: "40",
      recordedDate: "2026-11-08",
      notes: "Roadside",
    }));
    expect(outside.ok).toBe(true);
    const tooMuch = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: savedListing.id,
      category: "spoiled",
      quantity: "1",
      recordedDate: "2026-11-09",
    }));
    expect(tooMuch.ok).toBe(false);
    const after = await repository.listPurchases();
    const outcomes = await repository.listOutcomes();
    if (!before.ok || !after.ok || !outcomes.ok) throw new Error("records could not be read");
    expect(after.value).toHaveLength(before.value.length);
    expect(outcomes.value).toHaveLength(2);
    expect((await repository.getListing(savedListing.id)).ok).toBe(true);
  });

  it("keeps an expected harvest outcome out of ready-to-collect surplus and reloads it", async () => {
    const store = memoryStore();
    const repository = localRepository(store);
    const farmer = sessionFor("farmer@nyuma.ke");
    const saved = await createListingRecord(repository, farmer, listing, "open");
    if (!saved.ok) throw new Error(saved.message);
    const recorded = await recordOutcomeRecord(repository, farmer, outcome({
      listingId: saved.value.id,
      category: "spoiled",
      quantity: "25",
      notes: "After harvest",
    }));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const reloaded = localRepository(store);
    const outcomes = await reloaded.listOutcomes();
    const listings = await reloaded.listListings();
    expect(outcomes.ok && outcomes.value.map((item) => item.id)).toEqual([recorded.value.id]);
    expect(listings.ok && listings.value[0]?.quantity).toBe(800);
    expect(listings.ok && listings.value[0]?.quantityKind).toBe("expected");
    store.failWrites = true;
    const failed = await recordOutcomeRecord(reloaded, farmer, outcome({
      listingId: saved.value.id,
      category: "donated",
      quantity: "5",
      recordedDate: "2026-11-10",
    }));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toContain("blocked local storage");
    const still = await localRepository(store).listOutcomes();
    expect(still.ok && still.value).toHaveLength(1);
    expect(still.ok && still.value[0]?.id).toBe(recorded.value.id);
  });
});
