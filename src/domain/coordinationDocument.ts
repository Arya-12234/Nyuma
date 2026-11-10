import { checkDocumentInvariants } from "./relationships";
import type { CoordinationDocumentV1 } from "./records";
import { failure, success, type DomainResult } from "./result";
import {
  parseBuyerDemand,
  parseCommitment,
  parseListing,
  parseOutcome,
  parsePurchase,
} from "./validateRecords";

/**
 * Coordination records use their own key so they never share the decision-support scenario save
 * (`nyuma.decisionSupport.scenario.v1`).
 * Version 1 is the only schema this build reads. Another version is migrated only by an explicit
 * migration that returns a version 1 document. A failed read never replaces the stored value.
 */
export const COORDINATION_STORAGE_KEY = "nyuma.coordination.v1";
export const COORDINATION_SCHEMA_VERSION = 1;

export interface CoordinationKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CoordinationMigration {
  fromVersion: number;
  migrate(raw: unknown): unknown;
}

/** Version 1 has no migrations. Register one here before reading an older or newer document. */
export const COORDINATION_MIGRATIONS: readonly CoordinationMigration[] = [];

const DOCUMENT_KEYS = ["version", "listings", "buyerDemands", "commitments", "purchases", "outcomes"] as const;

export function emptyCoordinationDocument(): CoordinationDocumentV1 {
  return {
    version: COORDINATION_SCHEMA_VERSION,
    listings: [],
    buyerDemands: [],
    commitments: [],
    purchases: [],
    outcomes: [],
  };
}

export function parseCoordinationDocument(
  raw: unknown,
  migrations: readonly CoordinationMigration[] = COORDINATION_MIGRATIONS,
): DomainResult<CoordinationDocumentV1> {
  if (!isPlainObject(raw)) {
    return failure("malformed", "Stored coordination data must be an object. The stored data was left unchanged.");
  }
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return failure("malformed", "Stored coordination data has no schema version. The stored data was left unchanged.");
  }
  if (version !== COORDINATION_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.fromVersion === version);
    if (!migration) {
      return failure(
        "unsupported-version",
        `Stored coordination data uses version ${version}, which this version of Nyuma cannot read. The stored data was left unchanged.`,
      );
    }
    let migrated: unknown;
    try {
      migrated = migration.migrate(raw);
    } catch {
      return failure(
        "unsupported-version",
        `Stored coordination data uses version ${version} and could not be migrated. The stored data was left unchanged.`,
      );
    }
    return parseVersion1(migrated);
  }
  return parseVersion1(raw);
}

export function readCoordinationDocument(store: CoordinationKeyValueStore): DomainResult<CoordinationDocumentV1> {
  let raw: string | null;
  try {
    raw = store.getItem(COORDINATION_STORAGE_KEY);
  } catch {
    return failure("storage", "This browser blocked local storage, so coordination records could not be read.");
  }
  if (raw === null || raw === "") return success(emptyCoordinationDocument());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("malformed", "Stored coordination data is not valid JSON. The stored data was left unchanged.");
  }
  return parseCoordinationDocument(parsed);
}

export function writeCoordinationDocument(
  store: CoordinationKeyValueStore,
  document: CoordinationDocumentV1,
): DomainResult<CoordinationDocumentV1> {
  const parsed = parseCoordinationDocument(document);
  if (!parsed.ok) return parsed;
  try {
    store.setItem(COORDINATION_STORAGE_KEY, JSON.stringify(parsed.value));
  } catch {
    return failure("storage", "This browser blocked local storage, so coordination records could not be saved.");
  }
  return parsed;
}

function parseVersion1(raw: unknown): DomainResult<CoordinationDocumentV1> {
  if (!isPlainObject(raw)) {
    return failure("malformed", "Stored coordination data must be an object. The stored data was left unchanged.");
  }
  if (raw.version !== COORDINATION_SCHEMA_VERSION) {
    return failure(
      "unsupported-version",
      `Stored coordination data uses version ${String(raw.version)}, which this version of Nyuma cannot read. The stored data was left unchanged.`,
    );
  }
  const keys = Object.keys(raw);
  const unknown = keys.find((key) => !DOCUMENT_KEYS.includes(key as (typeof DOCUMENT_KEYS)[number]));
  if (unknown) {
    return failure("malformed", `Stored coordination data has unrecognised field ${unknown}. The stored data was left unchanged.`);
  }
  const missing = DOCUMENT_KEYS.find((key) => key !== "version" && !keys.includes(key));
  if (missing) {
    return failure("malformed", `Stored coordination data is missing ${missing}. The stored data was left unchanged.`);
  }

  const listings = parseCollection(raw.listings, "listings", parseListing);
  if (!listings.ok) return listings;
  const buyerDemands = parseCollection(raw.buyerDemands, "buyerDemands", parseBuyerDemand);
  if (!buyerDemands.ok) return buyerDemands;
  const commitments = parseCollection(raw.commitments, "commitments", parseCommitment);
  if (!commitments.ok) return commitments;
  const purchases = parseCollection(raw.purchases, "purchases", parsePurchase);
  if (!purchases.ok) return purchases;
  const outcomes = parseCollection(raw.outcomes, "outcomes", parseOutcome);
  if (!outcomes.ok) return outcomes;

  const document: CoordinationDocumentV1 = {
    version: 1,
    listings: listings.value,
    buyerDemands: buyerDemands.value,
    commitments: commitments.value,
    purchases: purchases.value,
    outcomes: outcomes.value,
  };
  const invariants = checkDocumentInvariants(document, "store");
  if (!invariants.ok) return invariants;
  return success(document);
}

function parseCollection<T>(
  raw: unknown,
  name: string,
  parseOne: (value: unknown, label: string) => DomainResult<T>,
): DomainResult<T[]> {
  if (!Array.isArray(raw)) {
    return failure("malformed", `${name} must be a list. The stored data was left unchanged.`);
  }
  const items: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseOne(raw[index], `${name}[${index}]`);
    if (!parsed.ok) {
      return failure(parsed.code, `${parsed.message} The stored data was left unchanged.`);
    }
    items.push(parsed.value);
  }
  return success(items);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
