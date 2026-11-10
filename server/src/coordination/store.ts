import { randomBytes } from "node:crypto";
import pg from "pg";
import type { ClientBase } from "pg";
import { AccountNotBootstrapped, InvalidRequest } from "../auth/identity.js";
import { currentRequestToken, withPooledSession } from "../db/session.js";
import { runTransaction } from "../db/transaction.js";
import { Conflict, RecordNotFound, RelationshipConflict, RoleNotGranted } from "./errors.js";
import type {
  AgreementStatusPatch,
  AgreementWrite,
  DemandPatch,
  DemandWrite,
  ListingPatch,
  ListingWrite,
  OutcomeWrite,
  PurchaseWrite,
} from "./input.js";

export interface ListingRecord {
  id: string;
  ownerId: string;
  commodity: ListingWrite["commodity"];
  quantity: number;
  quantityUnit: "kg";
  quantityKind: ListingWrite["quantityKind"];
  location: ListingWrite["location"];
  availabilityWindow: ListingWrite["availabilityWindow"];
  askingPriceKshPerKg: number | null;
  status: ListingWrite["status"];
  createdAt: string;
  updatedAt: string;
}

export interface MarketListing {
  id: string;
  commodity: ListingWrite["commodity"];
  quantity: number;
  quantityUnit: "kg";
  quantityKind: ListingWrite["quantityKind"];
  location: ListingWrite["location"];
  availabilityWindow: ListingWrite["availabilityWindow"];
  askingPriceKshPerKg: number | null;
  status: "open";
}

export interface DemandRecord {
  id: string;
  buyerId: string;
  commodity: DemandWrite["commodity"];
  requestedQuantity: number;
  quantityUnit: "kg";
  preferredLocation: DemandWrite["preferredLocation"];
  collectionWindow: DemandWrite["collectionWindow"];
  indicativePriceKshPerKg: number | null;
  status: DemandWrite["status"];
  createdAt: string;
  updatedAt: string;
}

export interface MarketDemand {
  id: string;
  commodity: DemandWrite["commodity"];
  requestedQuantity: number;
  quantityUnit: "kg";
  preferredLocation: DemandWrite["preferredLocation"];
  collectionWindow: DemandWrite["collectionWindow"];
  indicativePriceKshPerKg: number | null;
  status: "open";
}

export interface CoordinationStore {
  createListing(accountId: string, input: ListingWrite): Promise<ListingRecord>;
  listOwnListings(accountId: string): Promise<ListingRecord[]>;
  getOwnListing(accountId: string, id: string): Promise<ListingRecord>;
  updateListing(accountId: string, id: string, patch: ListingPatch): Promise<ListingRecord>;
  deleteListing(accountId: string, id: string): Promise<void>;
  listOpenListings(): Promise<MarketListing[]>;
  createDemand(accountId: string, input: DemandWrite): Promise<DemandRecord>;
  listOwnDemands(accountId: string): Promise<DemandRecord[]>;
  getOwnDemand(accountId: string, id: string): Promise<DemandRecord>;
  updateDemand(accountId: string, id: string, patch: DemandPatch): Promise<DemandRecord>;
  deleteDemand(accountId: string, id: string): Promise<void>;
  listOpenDemands(): Promise<MarketDemand[]>;
  createAgreement(accountId: string, input: AgreementWrite): Promise<AgreementRecord>;
  listAgreements(accountId: string): Promise<AgreementRecord[]>;
  getAgreement(accountId: string, id: string): Promise<AgreementRecord>;
  updateAgreementStatus(accountId: string, id: string, patch: AgreementStatusPatch): Promise<AgreementRecord>;
  createPurchase(accountId: string, input: PurchaseWrite): Promise<PurchaseRecord>;
  listPurchases(accountId: string): Promise<PurchaseRecord[]>;
  getPurchase(accountId: string, id: string): Promise<PurchaseRecord>;
  createOutcome(accountId: string, input: OutcomeWrite): Promise<OutcomeRecord>;
  listOutcomes(accountId: string): Promise<OutcomeRecord[]>;
  getOutcome(accountId: string, id: string): Promise<OutcomeRecord>;
  close(): Promise<void>;
}

export interface AgreementRecord {
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

export interface PurchaseRecord {
  id: string;
  commitmentId: string;
  listingId: string;
  actualQuantity: number;
  quantityUnit: "kg";
  actualPriceKshPerKg: number;
  purchaseDate: string;
  recordedAt: string;
}

export interface OutcomeRecord {
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

const listingColumns = `id, owner_id, commodity, quantity::text AS quantity, quantity_unit, quantity_kind,
  location, availability_window, asking_price_ksh_per_kg::text AS asking_price, status, created_at, updated_at`;

const demandColumns = `id, buyer_id, commodity, requested_quantity::text AS requested_quantity, quantity_unit,
  preferred_location, collection_window, indicative_price_ksh_per_kg::text AS indicative_price, status, created_at, updated_at`;

const agreementColumns = `c.id, c.listing_id, c.buyer_demand_id, c.agreed_quantity::text AS agreed_quantity, c.quantity_unit,
  c.agreed_price_ksh_per_kg::text AS agreed_price, c.expected_fulfilment_date, c.status, c.created_at, c.updated_at`;

const purchaseColumns = `p.id, p.commitment_id, p.listing_id, p.actual_quantity::text AS actual_quantity, p.quantity_unit,
  p.actual_price_ksh_per_kg::text AS actual_price, p.purchase_date, p.recorded_at`;

const outcomeColumns = `o.id, o.listing_id, o.commitment_id, o.purchase_id, o.category, o.quantity::text AS quantity,
  o.quantity_unit, o.recorded_date, o.notes, o.recorded_at`;

function partySql(account: string): string {
  return `(
    (l.owner_id = ${account} AND EXISTS (
      SELECT 1 FROM user_roles ur WHERE ur.user_id = ${account} AND ur.role IN ('farmer', 'trader')
    ))
    OR (d.buyer_id = ${account} AND EXISTS (
      SELECT 1 FROM user_roles ur WHERE ur.user_id = ${account} AND ur.role = 'buyer'
    ))
  )`;
}

/**
 * Account ids passed into this store are Nyuma `users.id` values already resolved
 * from the verified token. SQL predicates repeat that id. Client owner fields are
 * not accepted here.
 *
 * Quantity changes lock the owned row with the owner predicate. They do not call
 * `nyuma_lock_listing` or `nyuma_lock_demand`, because those functions lock by id
 * alone and would confirm that another account's id exists.
 */
export function createPostgresCoordinationStore(databaseUrl: string): CoordinationStore {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
  return {
    createListing(accountId, input) {
      return withClient(pool, (client) =>
        write("insert", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader"]);
            const inserted = await tx.query<ListingRow>(
              `INSERT INTO listings (
                 id, owner_id, commodity, quantity, quantity_unit, quantity_kind,
                 location, availability_window, asking_price_ksh_per_kg, status
               ) VALUES ($1, $2, $3, $4, 'kg', $5, $6, $7, $8, $9)
               RETURNING ${listingColumns}`,
              [
                newId("l"),
                accountId,
                input.commodity,
                quantityParameter(input.quantity),
                input.quantityKind,
                input.location,
                input.availabilityWindow,
                priceParameter(input.askingPriceKshPerKg),
                input.status,
              ],
            );
            return toListing(inserted.rows[0]);
          }),
        ),
      );
    },
    listOwnListings(accountId) {
      return withClient(pool, async (client) => {
        const result = await client.query<ListingRow>(
          `SELECT ${listingColumns} FROM listings WHERE owner_id = $1 ORDER BY created_at, id`,
          [accountId],
        );
        return result.rows.map(toListing);
      });
    },
    getOwnListing(accountId, id) {
      return withClient(pool, async (client) => {
        const result = await client.query<ListingRow>(
          `SELECT ${listingColumns} FROM listings WHERE id = $1 AND owner_id = $2`,
          [id, accountId],
        );
        const row = result.rows[0];
        if (!row) throw new RecordNotFound();
        return toListing(row);
      });
    },
    updateListing(accountId, id, patch) {
      return withClient(pool, (client) =>
        write("update", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader"]);
            const current = await tx.query<ListingRow>(
              `SELECT ${listingColumns} FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
              [id, accountId],
            );
            const row = current.rows[0];
            if (!row) throw new RecordNotFound();
            const existing = toListing(row);
            const updated = await tx.query<ListingRow>(
              `UPDATE listings
               SET quantity = $3, quantity_kind = $4, location = $5, availability_window = $6,
                   asking_price_ksh_per_kg = $7, status = $8, updated_at = clock_timestamp()
               WHERE id = $1 AND owner_id = $2
               RETURNING ${listingColumns}`,
              [
                id,
                accountId,
                quantityParameter(patch.quantity ?? existing.quantity),
                patch.quantityKind ?? existing.quantityKind,
                patch.location ?? existing.location,
                patch.availabilityWindow ?? existing.availabilityWindow,
                priceParameter(patch.askingPriceKshPerKg === undefined ? existing.askingPriceKshPerKg : patch.askingPriceKshPerKg),
                patch.status ?? existing.status,
              ],
            );
            const next = updated.rows[0];
            if (!next) throw new RecordNotFound();
            return toListing(next);
          }),
        ),
      );
    },
    deleteListing(accountId, id) {
      return withClient(pool, (client) =>
        write("delete", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader"]);
            const result = await tx.query("DELETE FROM listings WHERE id = $1 AND owner_id = $2 RETURNING id", [id, accountId]);
            if ((result.rowCount ?? 0) === 0) throw new RecordNotFound();
          }),
        ),
      );
    },
    listOpenListings() {
      return withClient(pool, async (client) => {
        const result = await client.query<MarketListingRow>(
          `SELECT id, commodity, quantity::text AS quantity, quantity_unit, quantity_kind,
                  location, availability_window, asking_price_ksh_per_kg::text AS asking_price, status
           FROM listings
           WHERE status = 'open' AND origin = 'live'
           ORDER BY created_at, id`,
        );
        return result.rows.map(toMarketListing);
      });
    },
    createDemand(accountId, input) {
      return withClient(pool, (client) =>
        write("insert", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["buyer"]);
            const inserted = await tx.query<DemandRow>(
              `INSERT INTO buyer_demands (
                 id, buyer_id, commodity, requested_quantity, quantity_unit,
                 preferred_location, collection_window, indicative_price_ksh_per_kg, status
               ) VALUES ($1, $2, $3, $4, 'kg', $5, $6, $7, $8)
               RETURNING ${demandColumns}`,
              [
                newId("d"),
                accountId,
                input.commodity,
                quantityParameter(input.requestedQuantity),
                input.preferredLocation,
                input.collectionWindow,
                priceParameter(input.indicativePriceKshPerKg),
                input.status,
              ],
            );
            return toDemand(inserted.rows[0]);
          }),
        ),
      );
    },
    listOwnDemands(accountId) {
      return withClient(pool, async (client) => {
        const result = await client.query<DemandRow>(
          `SELECT ${demandColumns} FROM buyer_demands WHERE buyer_id = $1 ORDER BY created_at, id`,
          [accountId],
        );
        return result.rows.map(toDemand);
      });
    },
    getOwnDemand(accountId, id) {
      return withClient(pool, async (client) => {
        const result = await client.query<DemandRow>(
          `SELECT ${demandColumns} FROM buyer_demands WHERE id = $1 AND buyer_id = $2`,
          [id, accountId],
        );
        const row = result.rows[0];
        if (!row) throw new RecordNotFound();
        return toDemand(row);
      });
    },
    updateDemand(accountId, id, patch) {
      return withClient(pool, (client) =>
        write("update", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["buyer"]);
            const current = await tx.query<DemandRow>(
              `SELECT ${demandColumns} FROM buyer_demands WHERE id = $1 AND buyer_id = $2 FOR UPDATE`,
              [id, accountId],
            );
            const row = current.rows[0];
            if (!row) throw new RecordNotFound();
            const existing = toDemand(row);
            const updated = await tx.query<DemandRow>(
              `UPDATE buyer_demands
               SET requested_quantity = $3, preferred_location = $4, collection_window = $5,
                   indicative_price_ksh_per_kg = $6, status = $7, updated_at = clock_timestamp()
               WHERE id = $1 AND buyer_id = $2
               RETURNING ${demandColumns}`,
              [
                id,
                accountId,
                quantityParameter(patch.requestedQuantity ?? existing.requestedQuantity),
                patch.preferredLocation ?? existing.preferredLocation,
                patch.collectionWindow ?? existing.collectionWindow,
                priceParameter(
                  patch.indicativePriceKshPerKg === undefined ? existing.indicativePriceKshPerKg : patch.indicativePriceKshPerKg,
                ),
                patch.status ?? existing.status,
              ],
            );
            const next = updated.rows[0];
            if (!next) throw new RecordNotFound();
            return toDemand(next);
          }),
        ),
      );
    },
    deleteDemand(accountId, id) {
      return withClient(pool, (client) =>
        write("delete", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["buyer"]);
            const result = await tx.query("DELETE FROM buyer_demands WHERE id = $1 AND buyer_id = $2 RETURNING id", [id, accountId]);
            if ((result.rowCount ?? 0) === 0) throw new RecordNotFound();
          }),
        ),
      );
    },
    listOpenDemands() {
      return withClient(pool, async (client) => {
        const result = await client.query<MarketDemandRow>(
          `SELECT id, commodity, requested_quantity::text AS requested_quantity, quantity_unit,
                  preferred_location, collection_window, indicative_price_ksh_per_kg::text AS indicative_price, status
           FROM buyer_demands
           WHERE status = 'open' AND origin = 'live'
           ORDER BY created_at, id`,
        );
        return result.rows.map(toMarketDemand);
      });
    },
    createAgreement(accountId, input) {
      return withClient(pool, (client) =>
        write("insert", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader", "buyer"]);
            const id = newId("c");
            await tx.query("SELECT nyuma_insert_commitment($1, $2, $3, $4, $5, $6::date, $7)", [
              id,
              input.listingId,
              input.buyerDemandId,
              quantityParameter(input.agreedQuantity),
              priceParameter(input.agreedPriceKshPerKg),
              input.expectedFulfilmentDate,
              input.status,
            ]);
            return readAgreement(tx, accountId, id);
          }),
        ),
      );
    },
    listAgreements(accountId) {
      return withClient(pool, async (client) => {
        const result = await client.query<AgreementRow>(
          `SELECT ${agreementColumns}
           FROM commitments c
           JOIN listings l ON l.id = c.listing_id
           JOIN buyer_demands d ON d.id = c.buyer_demand_id
           WHERE ${partySql("$1")}
           ORDER BY c.created_at, c.id`,
          [accountId],
        );
        return result.rows.map((row) => toAgreement(row));
      });
    },
    getAgreement(accountId, id) {
      return withClient(pool, (client) => readAgreement(client, accountId, id));
    },
    updateAgreementStatus(accountId, id, patch) {
      return withClient(pool, (client) =>
        write("update", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader", "buyer"]);
            const current = await tx.query(
              `SELECT c.id
               FROM commitments c
               JOIN listings l ON l.id = c.listing_id
               JOIN buyer_demands d ON d.id = c.buyer_demand_id
               WHERE c.id = $1 AND ${partySql("$2")}`,
              [id, accountId],
            );
            if ((current.rowCount ?? 0) === 0) throw new RecordNotFound();
            await tx.query("SELECT nyuma_set_commitment_status($1, $2)", [id, patch.status]);
            return readAgreement(tx, accountId, id);
          }),
        ),
      );
    },
    createPurchase(accountId, input) {
      return withClient(pool, (client) =>
        write("insert", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader", "buyer"]);
            const commitment = await tx.query<{ listing_id: string }>(
              `SELECT c.listing_id
               FROM commitments c
               JOIN listings l ON l.id = c.listing_id
               JOIN buyer_demands d ON d.id = c.buyer_demand_id
               WHERE c.id = $1 AND ${partySql("$2")}`,
              [input.commitmentId, accountId],
            );
            const listingId = commitment.rows[0]?.listing_id;
            if (!listingId) throw new RecordNotFound();
            const id = newId("p");
            await tx.query("SELECT nyuma_insert_purchase($1, $2, $3, $4, 'kg', $5, $6::date)", [
              id,
              input.commitmentId,
              listingId,
              quantityParameter(input.actualQuantity),
              priceParameter(input.actualPriceKshPerKg),
              input.purchaseDate,
            ]);
            return readPurchase(tx, accountId, id);
          }),
        ),
      );
    },
    listPurchases(accountId) {
      return withClient(pool, async (client) => {
        const result = await client.query<PurchaseRow>(
          `SELECT ${purchaseColumns}
           FROM purchases p
           JOIN commitments c ON c.id = p.commitment_id
           JOIN listings l ON l.id = c.listing_id
           JOIN buyer_demands d ON d.id = c.buyer_demand_id
           WHERE ${partySql("$1")}
           ORDER BY p.recorded_at, p.id`,
          [accountId],
        );
        return result.rows.map((row) => toPurchase(row));
      });
    },
    getPurchase(accountId, id) {
      return withClient(pool, (client) => readPurchase(client, accountId, id));
    },
    createOutcome(accountId, input) {
      return withClient(pool, (client) =>
        write("insert", () =>
          runTransaction(client, async (tx) => {
            await assertGranted(tx, accountId, ["farmer", "trader"]);
            const owned = await tx.query("SELECT id FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE", [
              input.listingId,
              accountId,
            ]);
            if ((owned.rowCount ?? 0) === 0) throw new RecordNotFound();
            let commitmentId: string | null = null;
            if (input.purchaseId) {
              const purchase = await tx.query<{ commitment_id: string }>(
                "SELECT commitment_id FROM purchases WHERE id = $1 AND listing_id = $2",
                [input.purchaseId, input.listingId],
              );
              commitmentId = purchase.rows[0]?.commitment_id ?? null;
              if (!commitmentId) throw new RecordNotFound();
            }
            const duplicate = await tx.query(
              `SELECT 1 FROM outcomes
               WHERE listing_id = $1 AND category = $2 AND quantity = $3 AND recorded_date = $4::date
                 AND purchase_id IS NOT DISTINCT FROM $5 AND commitment_id IS NOT DISTINCT FROM $6 AND notes = $7`,
              [
                input.listingId,
                input.category,
                quantityParameter(input.quantity),
                input.recordedDate,
                input.purchaseId,
                commitmentId,
                input.notes,
              ],
            );
            if ((duplicate.rowCount ?? 0) > 0) throw new Conflict();
            const id = newId("o");
            await tx.query("SELECT nyuma_insert_outcome($1, $2, $3, $4, $5, $6::date, $7)", [
              id,
              input.listingId,
              input.purchaseId,
              input.category,
              quantityParameter(input.quantity),
              input.recordedDate,
              input.notes,
            ]);
            return readOutcome(tx, accountId, id);
          }),
        ),
      );
    },
    listOutcomes(accountId) {
      return withClient(pool, async (client) => {
        const result = await client.query<OutcomeRow>(outcomeListSql(""), [accountId]);
        return result.rows.map((row) => toOutcome(row));
      });
    },
    getOutcome(accountId, id) {
      return withClient(pool, (client) => readOutcome(client, accountId, id));
    },
    async close() {
      await pool.end();
    },
  };
}

function withClient<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withPooledSession(pool, currentRequestToken(), work);
}

async function write<T>(operation: "insert" | "update" | "delete", work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof RecordNotFound ||
      error instanceof RoleNotGranted ||
      error instanceof InvalidRequest ||
      error instanceof AccountNotBootstrapped ||
      error instanceof Conflict ||
      error instanceof RelationshipConflict
    ) {
      throw error;
    }
    mapWriteError(error, operation);
  }
}

async function assertGranted(client: ClientBase, accountId: string, roles: readonly string[]): Promise<void> {
  try {
    await client.query("SELECT nyuma_lock_user($1)", [accountId]);
  } catch (error) {
    mapWriteError(error, "insert");
  }
  const result = await client.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1", [
    accountId,
    roles,
  ]);
  if ((result.rowCount ?? 0) === 0) throw new RoleNotGranted();
}

function mapWriteError(error: unknown, operation: "insert" | "update" | "delete"): never {
  const code = pgCode(error);
  const message = pgMessage(error);
  if (code === "23001" || code === "23503") {
    if (operation === "delete" || message.includes("violates foreign key") || message.includes("RESTRICT")) throw new RelationshipConflict();
    if (message.startsWith("User ") && message.includes("does not exist")) throw new AccountNotBootstrapped();
    if (message.includes("does not exist")) throw new RecordNotFound();
    throw new RelationshipConflict();
  }
  if (code === "23514" || code === "22P02" || code === "22003") throw new InvalidRequest();
  if (code === "23505") throw new Conflict();
  if (code === "P0001") {
    if (message.includes("farmer or trader role") || message.includes("buyer role")) throw new RoleNotGranted();
    throw new Conflict();
  }
  throw error;
}

function pgCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function pgMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String(error.message) : "";
}

function newId(prefix: "l" | "d" | "c" | "p" | "o"): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function quantityParameter(value: number): string {
  return value.toFixed(3);
}

function priceParameter(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

interface ListingRow {
  id: string;
  owner_id: string;
  commodity: string;
  quantity: string;
  quantity_unit: string;
  quantity_kind: string;
  location: string;
  availability_window: string;
  asking_price: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MarketListingRow {
  id: string;
  commodity: string;
  quantity: string;
  quantity_unit: string;
  quantity_kind: string;
  location: string;
  availability_window: string;
  asking_price: string | null;
  status: string;
}

interface DemandRow {
  id: string;
  buyer_id: string;
  commodity: string;
  requested_quantity: string;
  quantity_unit: string;
  preferred_location: string;
  collection_window: string;
  indicative_price: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MarketDemandRow {
  id: string;
  commodity: string;
  requested_quantity: string;
  quantity_unit: string;
  preferred_location: string;
  collection_window: string;
  indicative_price: string | null;
  status: string;
}

function toListing(row: ListingRow | undefined): ListingRecord {
  if (!row) throw new Error("storage");
  return {
    id: row.id,
    ownerId: row.owner_id,
    commodity: enumValue(row.commodity, ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const),
    quantity: scaledNumber(row.quantity, 3),
    quantityUnit: "kg",
    quantityKind: enumValue(row.quantity_kind, ["available", "expected"] as const),
    location: enumValue(row.location, ["Kitui", "Nairobi", "Other"] as const),
    availabilityWindow: enumValue(row.availability_window, ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const),
    askingPriceKshPerKg: row.asking_price === null ? null : scaledNumber(row.asking_price, 2),
    status: enumValue(row.status, ["draft", "open", "closed", "withdrawn"] as const),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toMarketListing(row: MarketListingRow): MarketListing {
  if (row.status !== "open") throw new Error("storage");
  return {
    id: row.id,
    commodity: enumValue(row.commodity, ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const),
    quantity: scaledNumber(row.quantity, 3),
    quantityUnit: "kg",
    quantityKind: enumValue(row.quantity_kind, ["available", "expected"] as const),
    location: enumValue(row.location, ["Kitui", "Nairobi", "Other"] as const),
    availabilityWindow: enumValue(row.availability_window, ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const),
    askingPriceKshPerKg: row.asking_price === null ? null : scaledNumber(row.asking_price, 2),
    status: "open",
  };
}

function toDemand(row: DemandRow | undefined): DemandRecord {
  if (!row) throw new Error("storage");
  return {
    id: row.id,
    buyerId: row.buyer_id,
    commodity: enumValue(row.commodity, ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const),
    requestedQuantity: scaledNumber(row.requested_quantity, 3),
    quantityUnit: "kg",
    preferredLocation: enumValue(row.preferred_location, ["Kitui", "Nairobi", "Other"] as const),
    collectionWindow: enumValue(row.collection_window, ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const),
    indicativePriceKshPerKg: row.indicative_price === null ? null : scaledNumber(row.indicative_price, 2),
    status: enumValue(row.status, ["open", "closed", "withdrawn"] as const),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toMarketDemand(row: MarketDemandRow): MarketDemand {
  if (row.status !== "open") throw new Error("storage");
  return {
    id: row.id,
    commodity: enumValue(row.commodity, ["Watermelon", "Mango", "Tomato", "Banana", "Other"] as const),
    requestedQuantity: scaledNumber(row.requested_quantity, 3),
    quantityUnit: "kg",
    preferredLocation: enumValue(row.preferred_location, ["Kitui", "Nairobi", "Other"] as const),
    collectionWindow: enumValue(row.collection_window, ["2 hours", "3 hours", "4 hours", "Today", "Tomorrow"] as const),
    indicativePriceKshPerKg: row.indicative_price === null ? null : scaledNumber(row.indicative_price, 2),
    status: "open",
  };
}

function enumValue<T extends string>(value: string, options: readonly T[]): T {
  if (options.includes(value as T)) return value as T;
  throw new Error("storage");
}

function scaledNumber(value: string, scale: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("storage");
  const factor = 10 ** scale;
  return Math.round(parsed * factor) / factor;
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("storage");
  return parsed.toISOString();
}

async function readAgreement(client: ClientBase, accountId: string, id: string): Promise<AgreementRecord> {
  const result = await client.query<AgreementRow>(
    `SELECT ${agreementColumns}
     FROM commitments c
     JOIN listings l ON l.id = c.listing_id
     JOIN buyer_demands d ON d.id = c.buyer_demand_id
     WHERE c.id = $2 AND ${partySql("$1")}`,
    [accountId, id],
  );
  const row = result.rows[0];
  if (!row) throw new RecordNotFound();
  return toAgreement(row);
}

async function readPurchase(client: ClientBase, accountId: string, id: string): Promise<PurchaseRecord> {
  const result = await client.query<PurchaseRow>(
    `SELECT ${purchaseColumns}
     FROM purchases p
     JOIN commitments c ON c.id = p.commitment_id
     JOIN listings l ON l.id = c.listing_id
     JOIN buyer_demands d ON d.id = c.buyer_demand_id
     WHERE p.id = $2 AND ${partySql("$1")}`,
    [accountId, id],
  );
  const row = result.rows[0];
  if (!row) throw new RecordNotFound();
  return toPurchase(row);
}

function outcomeListSql(idPredicate: string): string {
  return `SELECT ${outcomeColumns}, (l.owner_id = $1) AS owns_listing
    FROM outcomes o
    JOIN listings l ON l.id = o.listing_id
    WHERE (
      (l.owner_id = $1 AND EXISTS (
        SELECT 1 FROM user_roles ur WHERE ur.user_id = $1 AND ur.role IN ('farmer', 'trader')
      ))
      OR (
        o.category = 'sold'
        AND o.purchase_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM purchases p
          JOIN commitments c ON c.id = p.commitment_id
          JOIN buyer_demands d ON d.id = c.buyer_demand_id
          WHERE p.id = o.purchase_id
            AND d.buyer_id = $1
            AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = $1 AND ur.role = 'buyer')
        )
      )
    )
    ${idPredicate}
    ORDER BY o.recorded_at, o.id`;
}

async function readOutcome(client: ClientBase, accountId: string, id: string): Promise<OutcomeRecord> {
  const result = await client.query<OutcomeRow>(outcomeListSql("AND o.id = $2"), [accountId, id]);
  const row = result.rows[0];
  if (!row) throw new RecordNotFound();
  return toOutcome(row);
}

function toAgreement(row: AgreementRow): AgreementRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerDemandId: row.buyer_demand_id,
    agreedQuantity: scaledNumber(row.agreed_quantity, 3),
    quantityUnit: "kg",
    agreedPriceKshPerKg: scaledNumber(row.agreed_price, 2),
    expectedFulfilmentDate: calendarDate(row.expected_fulfilment_date),
    status: enumValue(row.status, ["proposed", "confirmed", "fulfilled", "cancelled"] as const),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toPurchase(row: PurchaseRow): PurchaseRecord {
  return {
    id: row.id,
    commitmentId: row.commitment_id,
    listingId: row.listing_id,
    actualQuantity: scaledNumber(row.actual_quantity, 3),
    quantityUnit: "kg",
    actualPriceKshPerKg: scaledNumber(row.actual_price, 2),
    purchaseDate: calendarDate(row.purchase_date),
    recordedAt: iso(row.recorded_at),
  };
}

function toOutcome(row: OutcomeRow): OutcomeRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    commitmentId: row.commitment_id,
    purchaseId: row.purchase_id,
    category: enumValue(row.category, ["sold", "recovered", "spoiled", "donated", "disposed"] as const),
    quantity: scaledNumber(row.quantity, 3),
    quantityUnit: "kg",
    recordedDate: calendarDate(row.recorded_date),
    notes: row.owns_listing ? row.notes : null,
    recordedAt: iso(row.recorded_at),
  };
}

function calendarDate(value: Date | string): string {
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (!match?.[1]) throw new Error("storage");
    return match[1];
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface AgreementRow {
  id: string;
  listing_id: string;
  buyer_demand_id: string;
  agreed_quantity: string;
  quantity_unit: string;
  agreed_price: string;
  expected_fulfilment_date: Date | string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PurchaseRow {
  id: string;
  commitment_id: string;
  listing_id: string;
  actual_quantity: string;
  quantity_unit: string;
  actual_price: string;
  purchase_date: Date | string;
  recorded_at: Date | string;
}

interface OutcomeRow {
  id: string;
  listing_id: string;
  commitment_id: string | null;
  purchase_id: string | null;
  category: string;
  quantity: string;
  quantity_unit: string;
  recorded_date: Date | string;
  notes: string;
  recorded_at: Date | string;
  owns_listing: boolean;
}
