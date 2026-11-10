import { ROLES, type Role } from "./sampleUsers";

export interface NyumaAccount {
  id: string;
  status: "active" | "suspended" | "deactivated";
  roles: Role[];
  activeRole: Role | null;
}

export type OrdinaryRole = "farmer" | "trader" | "buyer";

export interface RoleRequestSubmission {
  id: string | null;
  role: OrdinaryRole;
  status: "pending" | "granted";
  requestedAt: string | null;
  decidedAt: string | null;
}

export interface RoleRequestHistory {
  id: string;
  role: OrdinaryRole;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  granted: boolean;
}

export class NyumaApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "NyumaApiError";
    this.status = status;
    this.code = code;
  }
}

export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiListing {
  id: string;
  ownerId: string;
  commodity: "Watermelon" | "Mango" | "Tomato" | "Banana" | "Other";
  quantity: number;
  quantityUnit: "kg";
  quantityKind: "available" | "expected";
  location: "Kitui" | "Nairobi" | "Other";
  availabilityWindow: "2 hours" | "3 hours" | "4 hours" | "Today" | "Tomorrow";
  askingPriceKshPerKg: number | null;
  status: "draft" | "open" | "closed" | "withdrawn";
  createdAt: string;
  updatedAt: string;
}

export type MarketListing = Omit<ApiListing, "ownerId" | "createdAt" | "updatedAt" | "status"> & { status: "open" };

export interface ApiRequirement {
  id: string;
  buyerId: string;
  commodity: ApiListing["commodity"];
  requestedQuantity: number;
  quantityUnit: "kg";
  preferredLocation: ApiListing["location"];
  collectionWindow: ApiListing["availabilityWindow"];
  indicativePriceKshPerKg: number | null;
  status: "open" | "closed" | "withdrawn";
  createdAt: string;
  updatedAt: string;
}

export type MarketRequirement = Omit<ApiRequirement, "buyerId" | "createdAt" | "updatedAt" | "status"> & { status: "open" };

export interface ListingWrite {
  commodity: ApiListing["commodity"];
  quantity: number;
  quantityKind: ApiListing["quantityKind"];
  location: ApiListing["location"];
  availabilityWindow: ApiListing["availabilityWindow"];
  askingPriceKshPerKg: number | null;
  status: ApiListing["status"];
}

export type ListingUpdate = Partial<Omit<ListingWrite, "commodity">>;

export interface RequirementWrite {
  commodity: ApiRequirement["commodity"];
  requestedQuantity: number;
  preferredLocation: ApiRequirement["preferredLocation"];
  collectionWindow: ApiRequirement["collectionWindow"];
  indicativePriceKshPerKg: number | null;
  status: ApiRequirement["status"];
}

export type RequirementUpdate = Partial<Omit<RequirementWrite, "commodity">>;

export interface ApiAgreement {
  id: string;
  listingId: string;
  buyerDemandId: string;
  agreedQuantity: number;
  quantityUnit: "kg";
  agreedPriceKshPerKg: number;
  expectedFulfilmentDate: string;
  status: "proposed" | "confirmed" | "fulfilled" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface AgreementWrite {
  listingId: string;
  buyerDemandId: string;
  agreedQuantity: number;
  agreedPriceKshPerKg: number;
  expectedFulfilmentDate: string;
  status: "proposed" | "confirmed";
}

export interface AgreementStatusUpdate {
  status: ApiAgreement["status"];
}

export interface ApiPurchase {
  id: string;
  commitmentId: string;
  listingId: string;
  actualQuantity: number;
  quantityUnit: "kg";
  actualPriceKshPerKg: number;
  purchaseDate: string;
  recordedAt: string;
}

export interface PurchaseWrite {
  commitmentId: string;
  actualQuantity: number;
  actualPriceKshPerKg: number;
  purchaseDate: string;
}

export interface ApiOutcome {
  id: string;
  listingId: string;
  commitmentId: string | null;
  purchaseId: string | null;
  category: "sold" | "recovered" | "spoiled" | "donated" | "disposed";
  quantity: number;
  quantityUnit: "kg";
  recordedDate: string;
  notes: string | null;
  recordedAt: string;
}

export interface OutcomeWrite {
  listingId: string;
  category: ApiOutcome["category"];
  quantity: number;
  recordedDate: string;
  notes: string;
  purchaseId: string | null;
}

export interface NyumaApi {
  bootstrap(token: string): Promise<NyumaAccount>;
  account(token: string): Promise<NyumaAccount>;
  selectWorkspace(token: string, role: string): Promise<NyumaAccount>;
  submitRoleRequests(token: string, roles: readonly string[]): Promise<RoleRequestSubmission[]>;
  listRoleRequests(token: string): Promise<RoleRequestHistory[]>;
  createListing(token: string, input: ListingWrite): Promise<ApiListing>;
  listListings(token: string): Promise<ApiListing[]>;
  getListing(token: string, id: string): Promise<ApiListing>;
  updateListing(token: string, id: string, patch: ListingUpdate): Promise<ApiListing>;
  deleteListing(token: string, id: string): Promise<void>;
  listMarketListings(token: string): Promise<MarketListing[]>;
  createRequirement(token: string, input: RequirementWrite): Promise<ApiRequirement>;
  listRequirements(token: string): Promise<ApiRequirement[]>;
  getRequirement(token: string, id: string): Promise<ApiRequirement>;
  updateRequirement(token: string, id: string, patch: RequirementUpdate): Promise<ApiRequirement>;
  deleteRequirement(token: string, id: string): Promise<void>;
  listMarketRequirements(token: string): Promise<MarketRequirement[]>;
  createAgreement(token: string, input: AgreementWrite): Promise<ApiAgreement>;
  listAgreements(token: string): Promise<ApiAgreement[]>;
  getAgreement(token: string, id: string): Promise<ApiAgreement>;
  updateAgreement(token: string, id: string, patch: AgreementStatusUpdate): Promise<ApiAgreement>;
  createPurchase(token: string, input: PurchaseWrite): Promise<ApiPurchase>;
  listPurchases(token: string): Promise<ApiPurchase[]>;
  getPurchase(token: string, id: string): Promise<ApiPurchase>;
  createOutcome(token: string, input: OutcomeWrite): Promise<ApiOutcome>;
  listOutcomes(token: string): Promise<ApiOutcome[]>;
  getOutcome(token: string, id: string): Promise<ApiOutcome>;
}

const ORDINARY: readonly OrdinaryRole[] = ["farmer", "trader", "buyer"];

export function readApiBaseUrl(value: string | undefined): { ok: true; url: string } | { ok: false } {
  if (!value || !value.trim()) return { ok: true, url: "http://127.0.0.1:8787" };
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) return { ok: false };
    return { ok: true, url: url.origin };
  } catch {
    return { ok: false };
  }
}

export function createNyumaClient(baseUrl: string, fetchImpl: ApiFetch = fetch): NyumaApi {
  return {
    bootstrap(token) {
      return accountCall(baseUrl, token, "POST", "/me/bootstrap", {}, fetchImpl);
    },
    account(token) {
      return accountCall(baseUrl, token, "GET", "/me", undefined, fetchImpl);
    },
    selectWorkspace(token, role) {
      if (!isRole(role)) return Promise.reject(new NyumaApiError(400, "invalid-request"));
      return accountCall(baseUrl, token, "PUT", "/me/workspace", { role }, fetchImpl);
    },
    async submitRoleRequests(token, roles) {
      const accepted = ordinaryNames(roles);
      const payload = await send(baseUrl, token, "POST", "/me/role-requests", { roles: accepted }, fetchImpl);
      return readSubmissions(payload);
    },
    async listRoleRequests(token) {
      const payload = await send(baseUrl, token, "GET", "/me/role-requests", undefined, fetchImpl);
      return readHistory(payload);
    },
    async createListing(token, input) {
      return readListing(await send(baseUrl, token, "POST", "/me/listings", listingBody(input), fetchImpl));
    },
    async listListings(token) {
      return readListingList(await send(baseUrl, token, "GET", "/me/listings", undefined, fetchImpl));
    },
    async getListing(token, id) {
      return readListing(await send(baseUrl, token, "GET", recordPath("/me/listings/", id), undefined, fetchImpl));
    },
    async updateListing(token, id, patch) {
      return readListing(await send(baseUrl, token, "PATCH", recordPath("/me/listings/", id), listingPatchBody(patch), fetchImpl));
    },
    async deleteListing(token, id) {
      await send(baseUrl, token, "DELETE", recordPath("/me/listings/", id), undefined, fetchImpl);
    },
    async listMarketListings(token) {
      return readMarketListings(await send(baseUrl, token, "GET", "/market/listings", undefined, fetchImpl));
    },
    async createRequirement(token, input) {
      return readRequirement(await send(baseUrl, token, "POST", "/me/buyer-requirements", requirementBody(input), fetchImpl));
    },
    async listRequirements(token) {
      return readRequirementList(await send(baseUrl, token, "GET", "/me/buyer-requirements", undefined, fetchImpl));
    },
    async getRequirement(token, id) {
      return readRequirement(await send(baseUrl, token, "GET", recordPath("/me/buyer-requirements/", id), undefined, fetchImpl));
    },
    async updateRequirement(token, id, patch) {
      return readRequirement(
        await send(baseUrl, token, "PATCH", recordPath("/me/buyer-requirements/", id), requirementPatchBody(patch), fetchImpl),
      );
    },
    async deleteRequirement(token, id) {
      await send(baseUrl, token, "DELETE", recordPath("/me/buyer-requirements/", id), undefined, fetchImpl);
    },
    async listMarketRequirements(token) {
      return readMarketRequirements(await send(baseUrl, token, "GET", "/market/requirements", undefined, fetchImpl));
    },
    async createAgreement(token, input) {
      return readAgreement(await send(baseUrl, token, "POST", "/me/agreements", agreementBody(input), fetchImpl));
    },
    async listAgreements(token) {
      return readAgreementList(await send(baseUrl, token, "GET", "/me/agreements", undefined, fetchImpl));
    },
    async getAgreement(token, id) {
      return readAgreement(await send(baseUrl, token, "GET", recordPath("/me/agreements/", id), undefined, fetchImpl));
    },
    async updateAgreement(token, id, patch) {
      return readAgreement(await send(baseUrl, token, "PATCH", recordPath("/me/agreements/", id), { status: patch.status }, fetchImpl));
    },
    async createPurchase(token, input) {
      return readPurchase(await send(baseUrl, token, "POST", "/me/purchases", purchaseBody(input), fetchImpl));
    },
    async listPurchases(token) {
      return readPurchaseList(await send(baseUrl, token, "GET", "/me/purchases", undefined, fetchImpl));
    },
    async getPurchase(token, id) {
      return readPurchase(await send(baseUrl, token, "GET", recordPath("/me/purchases/", id), undefined, fetchImpl));
    },
    async createOutcome(token, input) {
      return readOutcome(await send(baseUrl, token, "POST", "/me/outcomes", outcomeBody(input), fetchImpl));
    },
    async listOutcomes(token) {
      return readOutcomeList(await send(baseUrl, token, "GET", "/me/outcomes", undefined, fetchImpl));
    },
    async getOutcome(token, id) {
      return readOutcome(await send(baseUrl, token, "GET", recordPath("/me/outcomes/", id), undefined, fetchImpl));
    },
  };
}

async function accountCall(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: ApiFetch,
): Promise<NyumaAccount> {
  return readAccount(await send(baseUrl, token, method, path, body, fetchImpl));
}

async function send(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: ApiFetch,
): Promise<unknown> {
  if (!token.trim()) throw new NyumaApiError(401, "unauthenticated");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, init);
  } catch {
    throw new NyumaApiError(0, "request-failed");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload ? payload.error : "request-failed";
    throw new NyumaApiError(response.status, safeCode(code, token));
  }
  return payload;
}

function safeCode(value: unknown, token: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !/^[a-z0-9-]+$/.test(value)) {
    return "request-failed";
  }
  if (value.includes(token)) return "request-failed";
  return value;
}

function readAccount(payload: unknown): NyumaAccount {
  const account = objectField(payload, "account");
  if (!account || typeof account.id !== "string" || account.id.trim() === "") throw new NyumaApiError(200, "request-failed");
  if (account.status !== "active" && account.status !== "suspended" && account.status !== "deactivated") {
    throw new NyumaApiError(200, "request-failed");
  }
  if (!Array.isArray(account.roles) || !account.roles.every(isRole)) throw new NyumaApiError(200, "request-failed");
  if (account.activeRole !== null && !isRole(account.activeRole)) throw new NyumaApiError(200, "request-failed");
  return {
    id: account.id,
    status: account.status,
    roles: account.roles,
    activeRole: account.activeRole,
  };
}

function readSubmissions(payload: unknown): RoleRequestSubmission[] {
  const requests = arrayField(payload, "requests");
  return requests.map((item) => {
    if (!item || typeof item !== "object") throw new NyumaApiError(200, "request-failed");
    const row = item as Record<string, unknown>;
    if (row.id !== null && typeof row.id !== "string") throw new NyumaApiError(200, "request-failed");
    if (!isOrdinary(row.role) || (row.status !== "pending" && row.status !== "granted")) {
      throw new NyumaApiError(200, "request-failed");
    }
    return {
      id: row.id,
      role: row.role,
      status: row.status,
      requestedAt: textOrNull(row.requestedAt),
      decidedAt: textOrNull(row.decidedAt),
    };
  });
}

function readHistory(payload: unknown): RoleRequestHistory[] {
  const requests = arrayField(payload, "requests");
  return requests.map((item) => {
    if (!item || typeof item !== "object") throw new NyumaApiError(200, "request-failed");
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !isOrdinary(row.role)) throw new NyumaApiError(200, "request-failed");
    if (row.status !== "pending" && row.status !== "approved" && row.status !== "rejected") {
      throw new NyumaApiError(200, "request-failed");
    }
    if (typeof row.requestedAt !== "string" || typeof row.granted !== "boolean") throw new NyumaApiError(200, "request-failed");
    return {
      id: row.id,
      role: row.role,
      status: row.status,
      requestedAt: row.requestedAt,
      decidedAt: textOrNull(row.decidedAt),
      decisionNote: textOrNull(row.decisionNote),
      granted: row.granted,
    };
  });
}

function objectField(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
    throw new NyumaApiError(200, "request-failed");
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayField(payload: unknown, key: string): unknown[] {
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
    throw new NyumaApiError(200, "request-failed");
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) throw new NyumaApiError(200, "request-failed");
  return value;
}

function textOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new NyumaApiError(200, "request-failed");
  return value;
}

function ordinaryNames(roles: readonly string[]): OrdinaryRole[] {
  const accepted = roles.filter(isOrdinary);
  if (accepted.length === 0 || accepted.length > 10 || accepted.length !== roles.length) {
    throw new NyumaApiError(400, "invalid-request");
  }
  return accepted;
}

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMODITIES = ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const;
const PLACES = ["Kitui", "Nairobi", "Other"] as const;
const WINDOWS = ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const;
const LISTING_STATUSES = ["draft", "open", "closed", "withdrawn"] as const;
const REQUIREMENT_STATUSES = ["open", "closed", "withdrawn"] as const;
const AGREEMENT_STATUSES = ["proposed", "confirmed", "fulfilled", "cancelled"] as const;
const OUTCOME_CATEGORIES = ["sold", "recovered", "spoiled", "donated", "disposed"] as const;

function recordPath(prefix: string, id: string): string {
  if (!RECORD_ID.test(id)) throw new NyumaApiError(404, "not-found");
  return `${prefix}${encodeURIComponent(id)}`;
}

function listingBody(input: ListingWrite): ListingWrite & { quantityUnit: "kg" } {
  return {
    commodity: input.commodity,
    quantity: input.quantity,
    quantityUnit: "kg",
    quantityKind: input.quantityKind,
    location: input.location,
    availabilityWindow: input.availabilityWindow,
    askingPriceKshPerKg: input.askingPriceKshPerKg,
    status: input.status,
  };
}

function listingPatchBody(patch: ListingUpdate): ListingUpdate {
  const body: ListingUpdate = {};
  if (patch.quantity !== undefined) body.quantity = patch.quantity;
  if (patch.quantityKind !== undefined) body.quantityKind = patch.quantityKind;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.availabilityWindow !== undefined) body.availabilityWindow = patch.availabilityWindow;
  if (patch.askingPriceKshPerKg !== undefined) body.askingPriceKshPerKg = patch.askingPriceKshPerKg;
  if (patch.status !== undefined) body.status = patch.status;
  return body;
}

function requirementBody(input: RequirementWrite): RequirementWrite & { quantityUnit: "kg" } {
  return {
    commodity: input.commodity,
    requestedQuantity: input.requestedQuantity,
    quantityUnit: "kg",
    preferredLocation: input.preferredLocation,
    collectionWindow: input.collectionWindow,
    indicativePriceKshPerKg: input.indicativePriceKshPerKg,
    status: input.status,
  };
}

function agreementBody(input: AgreementWrite): AgreementWrite & { quantityUnit: "kg" } {
  return {
    listingId: input.listingId,
    buyerDemandId: input.buyerDemandId,
    agreedQuantity: input.agreedQuantity,
    quantityUnit: "kg",
    agreedPriceKshPerKg: input.agreedPriceKshPerKg,
    expectedFulfilmentDate: input.expectedFulfilmentDate,
    status: input.status,
  };
}

function purchaseBody(input: PurchaseWrite): PurchaseWrite & { quantityUnit: "kg" } {
  return {
    commitmentId: input.commitmentId,
    actualQuantity: input.actualQuantity,
    quantityUnit: "kg",
    actualPriceKshPerKg: input.actualPriceKshPerKg,
    purchaseDate: input.purchaseDate,
  };
}

function outcomeBody(input: OutcomeWrite): OutcomeWrite & { quantityUnit: "kg" } {
  return {
    listingId: input.listingId,
    category: input.category,
    quantity: input.quantity,
    quantityUnit: "kg",
    recordedDate: input.recordedDate,
    notes: input.notes,
    purchaseId: input.purchaseId,
  };
}

function requirementPatchBody(patch: RequirementUpdate): RequirementUpdate {
  const body: RequirementUpdate = {};
  if (patch.requestedQuantity !== undefined) body.requestedQuantity = patch.requestedQuantity;
  if (patch.preferredLocation !== undefined) body.preferredLocation = patch.preferredLocation;
  if (patch.collectionWindow !== undefined) body.collectionWindow = patch.collectionWindow;
  if (patch.indicativePriceKshPerKg !== undefined) body.indicativePriceKshPerKg = patch.indicativePriceKshPerKg;
  if (patch.status !== undefined) body.status = patch.status;
  return body;
}

function readListing(payload: unknown): ApiListing {
  return listingFrom(objectField(payload, "listing"), true);
}

function readListingList(payload: unknown): ApiListing[] {
  return arrayField(payload, "listings").map((item) => listingFrom(item, true));
}

function readMarketListings(payload: unknown): MarketListing[] {
  return arrayField(payload, "listings").map((item) => {
    const listing = listingFrom(item, false);
    return {
      id: listing.id,
      commodity: listing.commodity,
      quantity: listing.quantity,
      quantityUnit: "kg",
      quantityKind: listing.quantityKind,
      location: listing.location,
      availabilityWindow: listing.availabilityWindow,
      askingPriceKshPerKg: listing.askingPriceKshPerKg,
      status: "open",
    };
  });
}

function readRequirement(payload: unknown): ApiRequirement {
  return requirementFrom(objectField(payload, "requirement"), true);
}

function readRequirementList(payload: unknown): ApiRequirement[] {
  return arrayField(payload, "requirements").map((item) => requirementFrom(item, true));
}

function readMarketRequirements(payload: unknown): MarketRequirement[] {
  return arrayField(payload, "requirements").map((item) => {
    const requirement = requirementFrom(item, false);
    return {
      id: requirement.id,
      commodity: requirement.commodity,
      requestedQuantity: requirement.requestedQuantity,
      quantityUnit: "kg",
      preferredLocation: requirement.preferredLocation,
      collectionWindow: requirement.collectionWindow,
      indicativePriceKshPerKg: requirement.indicativePriceKshPerKg,
      status: "open",
    };
  });
}

function listingFrom(value: unknown, owned: boolean): ApiListing {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NyumaApiError(200, "request-failed");
  const row = value as Record<string, unknown>;
  const status = oneOf(row.status, LISTING_STATUSES);
  if (!owned && status !== "open") throw new NyumaApiError(200, "request-failed");
  return {
    id: readRecordId(row.id),
    ownerId: owned ? readAccountId(row.ownerId) : "",
    commodity: oneOf(row.commodity, COMMODITIES),
    quantity: readMeasure(row.quantity, 3),
    quantityUnit: "kg",
    quantityKind: oneOf(row.quantityKind, ["available", "expected"] as const),
    location: oneOf(row.location, PLACES),
    availabilityWindow: oneOf(row.availabilityWindow, WINDOWS),
    askingPriceKshPerKg: readMeasureOrNull(row.askingPriceKshPerKg, 2),
    status,
    createdAt: owned ? readStamp(row.createdAt) : "1970-01-01T00:00:00.000Z",
    updatedAt: owned ? readStamp(row.updatedAt) : "1970-01-01T00:00:00.000Z",
  };
}

function requirementFrom(value: unknown, owned: boolean): ApiRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NyumaApiError(200, "request-failed");
  const row = value as Record<string, unknown>;
  const status = oneOf(row.status, REQUIREMENT_STATUSES);
  if (!owned && status !== "open") throw new NyumaApiError(200, "request-failed");
  return {
    id: readRecordId(row.id),
    buyerId: owned ? readAccountId(row.buyerId) : "",
    commodity: oneOf(row.commodity, COMMODITIES),
    requestedQuantity: readMeasure(row.requestedQuantity, 3),
    quantityUnit: "kg",
    preferredLocation: oneOf(row.preferredLocation, PLACES),
    collectionWindow: oneOf(row.collectionWindow, WINDOWS),
    indicativePriceKshPerKg: readMeasureOrNull(row.indicativePriceKshPerKg, 2),
    status,
    createdAt: owned ? readStamp(row.createdAt) : "1970-01-01T00:00:00.000Z",
    updatedAt: owned ? readStamp(row.updatedAt) : "1970-01-01T00:00:00.000Z",
  };
}

function readRecordId(value: unknown): string {
  if (typeof value !== "string" || !RECORD_ID.test(value)) throw new NyumaApiError(200, "request-failed");
  return value;
}

function readAccountId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 80) throw new NyumaApiError(200, "request-failed");
  return value;
}

function readStamp(value: unknown): string {
  if (typeof value !== "string") throw new NyumaApiError(200, "request-failed");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new NyumaApiError(200, "request-failed");
  return parsed.toISOString();
}

function readAgreement(payload: unknown): ApiAgreement {
  return agreementFrom(objectField(payload, "agreement"));
}

function readAgreementList(payload: unknown): ApiAgreement[] {
  return arrayField(payload, "agreements").map((item) => agreementFrom(item));
}

function readPurchase(payload: unknown): ApiPurchase {
  return purchaseFrom(objectField(payload, "purchase"));
}

function readPurchaseList(payload: unknown): ApiPurchase[] {
  return arrayField(payload, "purchases").map((item) => purchaseFrom(item));
}

function readOutcome(payload: unknown): ApiOutcome {
  return outcomeFrom(objectField(payload, "outcome"));
}

function readOutcomeList(payload: unknown): ApiOutcome[] {
  return arrayField(payload, "outcomes").map((item) => outcomeFrom(item));
}

function agreementFrom(value: unknown): ApiAgreement {
  const row = recordRow(value);
  return {
    id: readRecordId(row.id),
    listingId: readRecordId(row.listingId),
    buyerDemandId: readRecordId(row.buyerDemandId),
    agreedQuantity: readMeasure(row.agreedQuantity, 3),
    quantityUnit: "kg",
    agreedPriceKshPerKg: readMeasure(row.agreedPriceKshPerKg, 2),
    expectedFulfilmentDate: readCalendarDate(row.expectedFulfilmentDate),
    status: oneOf(row.status, AGREEMENT_STATUSES),
    createdAt: readStamp(row.createdAt),
    updatedAt: readStamp(row.updatedAt),
  };
}

function purchaseFrom(value: unknown): ApiPurchase {
  const row = recordRow(value);
  return {
    id: readRecordId(row.id),
    commitmentId: readRecordId(row.commitmentId),
    listingId: readRecordId(row.listingId),
    actualQuantity: readMeasure(row.actualQuantity, 3),
    quantityUnit: "kg",
    actualPriceKshPerKg: readMeasure(row.actualPriceKshPerKg, 2),
    purchaseDate: readCalendarDate(row.purchaseDate),
    recordedAt: readStamp(row.recordedAt),
  };
}

function outcomeFrom(value: unknown): ApiOutcome {
  const row = recordRow(value);
  return {
    id: readRecordId(row.id),
    listingId: readRecordId(row.listingId),
    commitmentId: readNullableRecordId(row.commitmentId),
    purchaseId: readNullableRecordId(row.purchaseId),
    category: oneOf(row.category, OUTCOME_CATEGORIES),
    quantity: readMeasure(row.quantity, 3),
    quantityUnit: "kg",
    recordedDate: readCalendarDate(row.recordedDate),
    notes: readNotes(row.notes),
    recordedAt: readStamp(row.recordedAt),
  };
}

function recordRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NyumaApiError(200, "request-failed");
  return value as Record<string, unknown>;
}

function readNullableRecordId(value: unknown): string | null {
  if (value === null) return null;
  return readRecordId(value);
}

function readCalendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new NyumaApiError(200, "request-failed");
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new NyumaApiError(200, "request-failed");
  }
  return value;
}

function readNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) throw new NyumaApiError(200, "request-failed");
  return value;
}

function readMeasure(value: unknown, scale: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new NyumaApiError(200, "request-failed");
  const factor = 10 ** scale;
  const scaled = Math.round(value * factor);
  if (!Number.isSafeInteger(scaled) || Math.abs(value * factor - scaled) > 1e-6) throw new NyumaApiError(200, "request-failed");
  return scaled / factor;
}

function readMeasureOrNull(value: unknown, scale: number): number | null {
  if (value === null) return null;
  return readMeasure(value, scale);
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value === "string" && options.includes(value as T)) return value as T;
  throw new NyumaApiError(200, "request-failed");
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.includes(value as Role);
}

function isOrdinary(value: unknown): value is OrdinaryRole {
  return typeof value === "string" && ORDINARY.includes(value as OrdinaryRole);
}
