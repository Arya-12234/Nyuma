import {
  parseCoordinationDocument,
  readCoordinationDocument,
  writeCoordinationDocument,
  type CoordinationKeyValueStore,
} from "./coordinationDocument";
import { checkDocumentInvariants } from "./relationships";
import type {
  BuyerDemand,
  BuyerDemandDraft,
  BuyerDemandPatch,
  Commitment,
  CommitmentDraft,
  CommitmentPatch,
  CommitmentStatus,
  CoordinationDocumentV1,
  Listing,
  ListingDraft,
  ListingPatch,
  Outcome,
  OutcomeDraft,
  Purchase,
  PurchaseDraft,
} from "./records";
import { failure, success, type DomainResult } from "./result";
import { isIsoTimestamp, parseBuyerDemand, parseBuyerDemandDraft, parseCommitment, parseCommitmentDraft, parseListing, parseListingDraft, parseOutcome, parseOutcomeDraft, parsePurchase, parsePurchaseDraft, parseRecordId } from "./validateRecords";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface RepositoryDeps {
  clock: Clock;
  ids: IdGenerator;
}

export interface CoordinationRepository {
  listListings(): Promise<DomainResult<readonly Listing[]>>;
  getListing(id: string): Promise<DomainResult<Listing>>;
  createListing(draft: ListingDraft): Promise<DomainResult<Listing>>;
  updateListing(id: string, patch: ListingPatch): Promise<DomainResult<Listing>>;

  listBuyerDemands(): Promise<DomainResult<readonly BuyerDemand[]>>;
  getBuyerDemand(id: string): Promise<DomainResult<BuyerDemand>>;
  createBuyerDemand(draft: BuyerDemandDraft): Promise<DomainResult<BuyerDemand>>;
  updateBuyerDemand(id: string, patch: BuyerDemandPatch): Promise<DomainResult<BuyerDemand>>;

  listCommitments(): Promise<DomainResult<readonly Commitment[]>>;
  getCommitment(id: string): Promise<DomainResult<Commitment>>;
  recordCommitment(draft: CommitmentDraft): Promise<DomainResult<Commitment>>;
  updateCommitment(id: string, patch: CommitmentPatch): Promise<DomainResult<Commitment>>;

  listPurchases(): Promise<DomainResult<readonly Purchase[]>>;
  getPurchase(id: string): Promise<DomainResult<Purchase>>;
  recordPurchase(draft: PurchaseDraft): Promise<DomainResult<Purchase>>;

  listOutcomes(): Promise<DomainResult<readonly Outcome[]>>;
  getOutcome(id: string): Promise<DomainResult<Outcome>>;
  recordOutcome(draft: OutcomeDraft): Promise<DomainResult<Outcome>>;
}

const LISTING_PATCH_KEYS = [
  "quantity",
  "quantityKind",
  "location",
  "availabilityWindow",
  "askingPriceKshPerKg",
  "status",
] as const;

const DEMAND_PATCH_KEYS = [
  "requestedQuantity",
  "preferredLocation",
  "collectionWindow",
  "indicativePriceKshPerKg",
  "status",
] as const;

const COMMITMENT_TRANSITIONS: Record<CommitmentStatus, readonly CommitmentStatus[]> = {
  proposed: ["confirmed", "cancelled"],
  confirmed: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

interface State {
  listings: Listing[];
  buyerDemands: BuyerDemand[];
  commitments: Commitment[];
  purchases: Purchase[];
  outcomes: Outcome[];
}

export interface InMemoryCoordinationRepository extends CoordinationRepository {
  snapshot(): CoordinationDocumentV1;
  replace(document: CoordinationDocumentV1): void;
}

export function createFixedClock(isoTimestamp: string): Clock {
  if (!isIsoTimestamp(isoTimestamp)) {
    throw new Error("Clock timestamps must use YYYY-MM-DDTHH:mm:ss.sssZ.");
  }
  return { now: () => isoTimestamp };
}

export function createSteppedClock(start: string): Clock {
  if (!isIsoTimestamp(start)) {
    throw new Error("Clock timestamps must use YYYY-MM-DDTHH:mm:ss.sssZ.");
  }
  let current = Date.parse(start);
  return {
    now() {
      const value = new Date(current).toISOString();
      current += 1000;
      return value;
    },
  };
}

export function createSequentialIdGenerator(): IdGenerator {
  const counts = new Map<string, number>();
  return {
    next(prefix: string) {
      const count = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, count);
      return `${prefix}-${count}`;
    },
  };
}

export function createInMemoryCoordinationRepository(
  deps: RepositoryDeps,
  seed?: CoordinationDocumentV1,
): InMemoryCoordinationRepository {
  const checked = parseCoordinationDocument(seed ?? emptyStateDocument());
  if (!checked.ok) throw new Error(checked.message);
  const state: State = {
    listings: checked.value.listings,
    buyerDemands: checked.value.buyerDemands,
    commitments: checked.value.commitments,
    purchases: checked.value.purchases,
    outcomes: checked.value.outcomes,
  };

  function commitChange<T>(change: (draft: State) => DomainResult<T>): DomainResult<T> {
    const draft = cloneState(state);
    const result = change(draft);
    if (!result.ok) return result;
    const invariants = checkDocumentInvariants(toDocument(draft), "change");
    if (!invariants.ok) return invariants;
    install(state, draft);
    return success(structuredClone(result.value));
  }

  return {
    async listListings() {
      return success(structuredClone(state.listings));
    },
    async getListing(id) {
      return findById(state.listings, id, "listing");
    },
    async createListing(draft) {
      return commitChange((draftState) => createListing(draftState, deps, draft));
    },
    async updateListing(id, patch) {
      return commitChange((draftState) => updateListing(draftState, deps, id, patch));
    },
    async listBuyerDemands() {
      return success(structuredClone(state.buyerDemands));
    },
    async getBuyerDemand(id) {
      return findById(state.buyerDemands, id, "buyer demand");
    },
    async createBuyerDemand(draft) {
      return commitChange((draftState) => createBuyerDemand(draftState, deps, draft));
    },
    async updateBuyerDemand(id, patch) {
      return commitChange((draftState) => updateBuyerDemand(draftState, deps, id, patch));
    },
    async listCommitments() {
      return success(structuredClone(state.commitments));
    },
    async getCommitment(id) {
      return findById(state.commitments, id, "commitment");
    },
    async recordCommitment(draft) {
      return commitChange((draftState) => recordCommitment(draftState, deps, draft));
    },
    async updateCommitment(id, patch) {
      return commitChange((draftState) => updateCommitment(draftState, deps, id, patch));
    },
    async listPurchases() {
      return success(structuredClone(state.purchases));
    },
    async getPurchase(id) {
      return findById(state.purchases, id, "purchase");
    },
    async recordPurchase(draft) {
      return commitChange((draftState) => recordPurchase(draftState, deps, draft));
    },
    async listOutcomes() {
      return success(structuredClone(state.outcomes));
    },
    async getOutcome(id) {
      return findById(state.outcomes, id, "outcome");
    },
    async recordOutcome(draft) {
      return commitChange((draftState) => recordOutcome(draftState, deps, draft));
    },
    snapshot() {
      return structuredClone(toDocument(state));
    },
    replace(document) {
      const checked = parseCoordinationDocument(structuredClone(document));
      if (!checked.ok) throw new Error(checked.message);
      install(state, {
        listings: checked.value.listings,
        buyerDemands: checked.value.buyerDemands,
        commitments: checked.value.commitments,
        purchases: checked.value.purchases,
        outcomes: checked.value.outcomes,
      });
    },
  };
}

export function createLocalCoordinationRepository(
  store: CoordinationKeyValueStore,
  deps: RepositoryDeps,
): CoordinationRepository {
  let opened: { ok: true; repository: InMemoryCoordinationRepository } | { ok: false; error: DomainResult<never> } | null =
    null;

  function open(): { ok: true; repository: InMemoryCoordinationRepository } | { ok: false; error: DomainResult<never> } {
    if (opened) return opened;
    const loaded = readCoordinationDocument(store);
    if (!loaded.ok) {
      opened = { ok: false, error: loaded };
      return opened;
    }
    opened = { ok: true, repository: createInMemoryCoordinationRepository(deps, loaded.value) };
    return opened;
  }

  async function mutate<T>(
    run: (repository: InMemoryCoordinationRepository) => Promise<DomainResult<T>>,
  ): Promise<DomainResult<T>> {
    const current = open();
    if (!current.ok) return current.error;
    const before = current.repository.snapshot();
    const result = await run(current.repository);
    if (!result.ok) return result;
    const written = writeCoordinationDocument(store, current.repository.snapshot());
    if (!written.ok) {
      current.repository.replace(before);
      return written;
    }
    return result;
  }

  async function read<T>(run: (repository: InMemoryCoordinationRepository) => Promise<DomainResult<T>>): Promise<DomainResult<T>> {
    const current = open();
    if (!current.ok) return current.error;
    return run(current.repository);
  }

  return {
    listListings: () => read((repository) => repository.listListings()),
    getListing: (id) => read((repository) => repository.getListing(id)),
    createListing: (draft) => mutate((repository) => repository.createListing(draft)),
    updateListing: (id, patch) => mutate((repository) => repository.updateListing(id, patch)),
    listBuyerDemands: () => read((repository) => repository.listBuyerDemands()),
    getBuyerDemand: (id) => read((repository) => repository.getBuyerDemand(id)),
    createBuyerDemand: (draft) => mutate((repository) => repository.createBuyerDemand(draft)),
    updateBuyerDemand: (id, patch) => mutate((repository) => repository.updateBuyerDemand(id, patch)),
    listCommitments: () => read((repository) => repository.listCommitments()),
    getCommitment: (id) => read((repository) => repository.getCommitment(id)),
    recordCommitment: (draft) => mutate((repository) => repository.recordCommitment(draft)),
    updateCommitment: (id, patch) => mutate((repository) => repository.updateCommitment(id, patch)),
    listPurchases: () => read((repository) => repository.listPurchases()),
    getPurchase: (id) => read((repository) => repository.getPurchase(id)),
    recordPurchase: (draft) => mutate((repository) => repository.recordPurchase(draft)),
    listOutcomes: () => read((repository) => repository.listOutcomes()),
    getOutcome: (id) => read((repository) => repository.getOutcome(id)),
    recordOutcome: (draft) => mutate((repository) => repository.recordOutcome(draft)),
  };
}

function createListing(state: State, deps: RepositoryDeps, draft: ListingDraft): DomainResult<Listing> {
  const parsed = saved(parseListingDraft(draft));
  if (!parsed.ok) return parsed;
  const id = resolveId(state, deps, parsed.value.id, "listing");
  if (!id.ok) return id;
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(
    parseListing({
      ...parsed.value,
      id: id.value,
      createdAt: now.value,
      updatedAt: now.value,
    }),
  );
  if (!record.ok) return record;
  state.listings = [...state.listings, record.value];
  return success(record.value);
}

function updateListing(state: State, deps: RepositoryDeps, id: string, patch: ListingPatch): DomainResult<Listing> {
  const shaped = asPatch(patch, "listing");
  if (!shaped.ok) return shaped;
  const unknown = rejectUnknownKeys(shaped.value, LISTING_PATCH_KEYS);
  if (unknown) return unknown;
  if (!LISTING_PATCH_KEYS.some((key) => shaped.value[key] !== undefined)) {
    return failure("invalid", "Nothing on this listing was changed. The change was not saved.");
  }
  const found = requireId(id);
  if (!found.ok) return saved(found);
  const index = state.listings.findIndex((listing) => listing.id === found.value);
  if (index < 0) return missing("listing", found.value);
  const now = takeTime(deps);
  if (!now.ok) return now;
  const current = state.listings[index];
  const record = saved(
    parseListing({
      ...current,
      ...definedFields(shaped.value, LISTING_PATCH_KEYS),
      id: current.id,
      ownerId: current.ownerId,
      commodity: current.commodity,
      quantityUnit: current.quantityUnit,
      createdAt: current.createdAt,
      updatedAt: now.value,
    }),
  );
  if (!record.ok) return record;
  const listings = state.listings.slice();
  listings[index] = record.value;
  state.listings = listings;
  return success(record.value);
}

function createBuyerDemand(state: State, deps: RepositoryDeps, draft: BuyerDemandDraft): DomainResult<BuyerDemand> {
  const parsed = saved(parseBuyerDemandDraft(draft));
  if (!parsed.ok) return parsed;
  const id = resolveId(state, deps, parsed.value.id, "demand");
  if (!id.ok) return id;
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(
    parseBuyerDemand({
      ...parsed.value,
      id: id.value,
      createdAt: now.value,
      updatedAt: now.value,
    }),
  );
  if (!record.ok) return record;
  state.buyerDemands = [...state.buyerDemands, record.value];
  return success(record.value);
}

function updateBuyerDemand(
  state: State,
  deps: RepositoryDeps,
  id: string,
  patch: BuyerDemandPatch,
): DomainResult<BuyerDemand> {
  const shaped = asPatch(patch, "buyer demand");
  if (!shaped.ok) return shaped;
  const unknown = rejectUnknownKeys(shaped.value, DEMAND_PATCH_KEYS);
  if (unknown) return unknown;
  if (!DEMAND_PATCH_KEYS.some((key) => shaped.value[key] !== undefined)) {
    return failure("invalid", "Nothing on this buyer demand was changed. The change was not saved.");
  }
  const found = requireId(id);
  if (!found.ok) return saved(found);
  const index = state.buyerDemands.findIndex((demand) => demand.id === found.value);
  if (index < 0) return missing("buyer demand", found.value);
  const now = takeTime(deps);
  if (!now.ok) return now;
  const current = state.buyerDemands[index];
  const record = saved(
    parseBuyerDemand({
      ...current,
      ...definedFields(shaped.value, DEMAND_PATCH_KEYS),
      id: current.id,
      buyerId: current.buyerId,
      commodity: current.commodity,
      quantityUnit: current.quantityUnit,
      createdAt: current.createdAt,
      updatedAt: now.value,
    }),
  );
  if (!record.ok) return record;
  const buyerDemands = state.buyerDemands.slice();
  buyerDemands[index] = record.value;
  state.buyerDemands = buyerDemands;
  return success(record.value);
}

function recordCommitment(state: State, deps: RepositoryDeps, draft: CommitmentDraft): DomainResult<Commitment> {
  const parsed = saved(parseCommitmentDraft(draft));
  if (!parsed.ok) return parsed;
  const listing = state.listings.find((item) => item.id === parsed.value.listingId);
  if (!listing) return missing("listing", parsed.value.listingId);
  const demand = state.buyerDemands.find((item) => item.id === parsed.value.buyerDemandId);
  if (!demand) return missing("buyer demand", parsed.value.buyerDemandId);
  if (listing.status !== "open") {
    return failure("relationship", "Record a commitment only while the listing is open. The change was not saved.");
  }
  if (demand.status !== "open") {
    return failure("relationship", "Record a commitment only while the buyer demand is open. The change was not saved.");
  }
  const id = resolveId(state, deps, parsed.value.id, "commitment");
  if (!id.ok) return id;
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(
    parseCommitment({
      ...parsed.value,
      id: id.value,
      createdAt: now.value,
      updatedAt: now.value,
    }),
  );
  if (!record.ok) return record;
  state.commitments = [...state.commitments, record.value];
  return success(record.value);
}

function updateCommitment(state: State, deps: RepositoryDeps, id: string, patch: CommitmentPatch): DomainResult<Commitment> {
  const shaped = asPatch(patch, "commitment");
  if (!shaped.ok) return shaped;
  const unknown = rejectUnknownKeys(shaped.value, ["status"]);
  if (unknown) return unknown;
  if (shaped.value.status === undefined) {
    return failure("invalid", "Nothing on this commitment was changed. The change was not saved.");
  }
  const found = requireId(id);
  if (!found.ok) return saved(found);
  const index = state.commitments.findIndex((commitment) => commitment.id === found.value);
  if (index < 0) return missing("commitment", found.value);
  const current = state.commitments[index];
  if (shaped.value.status === current.status) {
    return failure("relationship", `The commitment is already ${current.status}. The change was not saved.`);
  }
  if (!COMMITMENT_TRANSITIONS[current.status].includes(shaped.value.status as CommitmentStatus)) {
    return failure(
      "relationship",
      `A ${current.status} commitment cannot become ${String(shaped.value.status)}. The change was not saved.`,
    );
  }
  if (shaped.value.status === "cancelled" && state.purchases.some((purchase) => purchase.commitmentId === current.id)) {
    return failure("relationship", "This commitment has a recorded purchase, so it cannot be cancelled. The change was not saved.");
  }
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(parseCommitment({ ...current, status: shaped.value.status, updatedAt: now.value }));
  if (!record.ok) return record;
  const commitments = state.commitments.slice();
  commitments[index] = record.value;
  state.commitments = commitments;
  return success(record.value);
}

function recordPurchase(state: State, deps: RepositoryDeps, draft: PurchaseDraft): DomainResult<Purchase> {
  const parsed = saved(parsePurchaseDraft(draft));
  if (!parsed.ok) return parsed;
  const commitment = state.commitments.find((item) => item.id === parsed.value.commitmentId);
  if (!commitment) return missing("commitment", parsed.value.commitmentId);
  if (!state.listings.some((listing) => listing.id === parsed.value.listingId)) {
    return missing("listing", parsed.value.listingId);
  }
  if (commitment.status !== "confirmed") {
    return failure(
      "relationship",
      `Record a purchase only against a confirmed commitment. This commitment is ${commitment.status}. The change was not saved.`,
    );
  }
  const id = resolveId(state, deps, parsed.value.id, "purchase");
  if (!id.ok) return id;
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(parsePurchase({ ...parsed.value, id: id.value, recordedAt: now.value }));
  if (!record.ok) return record;
  state.purchases = [...state.purchases, record.value];
  return success(record.value);
}

function recordOutcome(state: State, deps: RepositoryDeps, draft: OutcomeDraft): DomainResult<Outcome> {
  const parsed = saved(parseOutcomeDraft(draft));
  if (!parsed.ok) return parsed;
  if (!state.listings.some((listing) => listing.id === parsed.value.listingId)) {
    return missing("listing", parsed.value.listingId);
  }
  if (parsed.value.commitmentId !== null && !state.commitments.some((item) => item.id === parsed.value.commitmentId)) {
    return missing("commitment", parsed.value.commitmentId);
  }
  if (parsed.value.purchaseId !== null && !state.purchases.some((item) => item.id === parsed.value.purchaseId)) {
    return missing("purchase", parsed.value.purchaseId);
  }
  const id = resolveId(state, deps, parsed.value.id, "outcome");
  if (!id.ok) return id;
  const now = takeTime(deps);
  if (!now.ok) return now;
  const record = saved(parseOutcome({ ...parsed.value, id: id.value, recordedAt: now.value }));
  if (!record.ok) return record;
  state.outcomes = [...state.outcomes, record.value];
  return success(record.value);
}

function findById<T extends { id: string }>(records: readonly T[], id: string, label: string): DomainResult<T> {
  const found = requireId(id);
  if (!found.ok) return found;
  const record = records.find((item) => item.id === found.value);
  if (!record) return failure("not-found", `No ${label} has the id ${found.value}.`);
  return success(structuredClone(record));
}

function requireId(id: string): DomainResult<string> {
  return parseRecordId(id);
}

function resolveId(state: State, deps: RepositoryDeps, requested: string | undefined, prefix: string): DomainResult<string> {
  const taken = knownIds(state);
  if (requested !== undefined) {
    if (taken.has(requested)) {
      return failure("conflict", `The id ${requested} is already used. The change was not saved.`);
    }
    return success(requested);
  }
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = deps.ids.next(prefix);
    if (!taken.has(id)) return success(id);
  }
  return failure("conflict", "A unique id could not be created. The change was not saved.");
}

function knownIds(state: State): Set<string> {
  return new Set([
    ...state.listings.map((record) => record.id),
    ...state.buyerDemands.map((record) => record.id),
    ...state.commitments.map((record) => record.id),
    ...state.purchases.map((record) => record.id),
    ...state.outcomes.map((record) => record.id),
  ]);
}

function takeTime(deps: RepositoryDeps): DomainResult<string> {
  const now = deps.clock.now();
  if (!isIsoTimestamp(now)) {
    return failure("invalid", "The repository clock returned a timestamp this version cannot store. The change was not saved.");
  }
  return success(now);
}

function missing(label: string, id: string): DomainResult<never> {
  return failure("not-found", `No ${label} has the id ${id}. The change was not saved.`);
}

function saved<T>(result: DomainResult<T>): DomainResult<T> {
  if (result.ok) return result;
  if (result.message.includes("The change was not saved.") || result.message.includes("The stored data was left unchanged.")) {
    return result;
  }
  return failure(result.code, `${result.message} The change was not saved.`);
}

function asPatch(value: unknown, label: string): DomainResult<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failure("invalid", `The ${label} update must be an object. The change was not saved.`);
  }
  return success(value as Record<string, unknown>);
}

function rejectUnknownKeys(patch: Record<string, unknown>, allowed: readonly string[]): DomainResult<never> | null {
  const unknown = Object.keys(patch).find((key) => !allowed.includes(key));
  if (!unknown) return null;
  return failure("invalid", `This update cannot change ${unknown}. The change was not saved.`);
}

function definedFields(patch: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

function toDocument(state: State): CoordinationDocumentV1 {
  return {
    version: 1,
    listings: state.listings,
    buyerDemands: state.buyerDemands,
    commitments: state.commitments,
    purchases: state.purchases,
    outcomes: state.outcomes,
  };
}

function emptyStateDocument(): CoordinationDocumentV1 {
  return { version: 1, listings: [], buyerDemands: [], commitments: [], purchases: [], outcomes: [] };
}

function cloneState(state: State): State {
  return {
    listings: structuredClone(state.listings),
    buyerDemands: structuredClone(state.buyerDemands),
    commitments: structuredClone(state.commitments),
    purchases: structuredClone(state.purchases),
    outcomes: structuredClone(state.outcomes),
  };
}

function install(state: State, next: State): void {
  state.listings = next.listings;
  state.buyerDemands = next.buyerDemands;
  state.commitments = next.commitments;
  state.purchases = next.purchases;
  state.outcomes = next.outcomes;
}
