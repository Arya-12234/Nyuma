import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { ClientBase, PoolClient } from "pg";
import { AssertionClientError } from "../assertion/client.js";
import { isMintedAssertionWire } from "../assertion/canonical.js";
import {
  IDENTITY_MODE_LOCAL_HS256_TEST,
  IDENTITY_MODE_SIGNER,
  type IdentityMode,
} from "../config/env.js";
import { assertApplicationRole } from "./applicationRole.js";

const requestTokens = new AsyncLocalStorage<string>();

const outerTransaction = new WeakSet<ClientBase>();
const sessionBearers = new WeakMap<ClientBase, string>();
const sessionAssertions = new WeakMap<ClientBase, string>();

/**
 * Unset until startup or a test selects a mode. A non-empty bearer then fails
 * closed. local-hs256-test writes the raw bearer and is not production-safe.
 * signer asks the assertion source and never writes the bearer.
 * PostgreSQL does not verify nya1 yet.
 */
let identityMode: IdentityMode | null = null;
let assertionSource: ((token: string) => Promise<string>) | null = null;

export function configureIdentityMode(mode: IdentityMode | null): void {
  identityMode = mode;
}

export function currentIdentityMode(): IdentityMode | null {
  return identityMode;
}

export function configureAssertionSource(source: ((token: string) => Promise<string>) | null): void {
  assertionSource = source;
}

/** Installs one identity path and returns the previous path for the caller to restore. */
export function useIdentity(
  mode: IdentityMode,
  source: ((token: string) => Promise<string>) | null,
): () => void {
  const previousMode = identityMode;
  const previousSource = assertionSource;
  identityMode = mode;
  assertionSource = mode === IDENTITY_MODE_SIGNER ? source : null;
  return () => {
    identityMode = previousMode;
    assertionSource = previousSource;
  };
}

/**
 * Clears any bearer token left on a pooled connection.
 * The value is never written to a log. A blank setting is not an account id.
 */
export async function clearAccessToken(client: ClientBase): Promise<void> {
  await client.query("SELECT set_config('nyuma.access_token', '', false)");
  await client.query("RESET nyuma.access_token");
}

/**
 * Mints before BEGIN in signer mode. A signer failure throws and does not write
 * the bearer token. local-hs256-test copies the bearer and does not call the signer.
 */
export async function prepareLocalAccess(client: ClientBase): Promise<void> {
  const bearer = sessionBearers.get(client) ?? "";
  if (identityMode === IDENTITY_MODE_LOCAL_HS256_TEST) {
    sessionAssertions.set(client, bearer);
    return;
  }
  if (bearer.trim() === "") {
    sessionAssertions.set(client, "");
    return;
  }
  if (identityMode !== IDENTITY_MODE_SIGNER || assertionSource === null) {
    throw new AssertionClientError();
  }
  let assertion: string;
  try {
    assertion = await assertionSource(bearer);
  } catch (error) {
    if (error instanceof AssertionClientError) throw error;
    throw new AssertionClientError();
  }
  if (!isMintedAssertionWire(assertion)) throw new AssertionClientError();
  sessionAssertions.set(client, assertion);
}

/** Applies the prepared value for this transaction only. The third argument is local. */
export async function applyLocalAccessToken(client: ClientBase): Promise<void> {
  const value = sessionAssertions.get(client) ?? "";
  await client.query("SELECT set_config('nyuma.access_token', $1, true)", [value]);
}

export function joinedTransaction(client: ClientBase): boolean {
  return outerTransaction.has(client);
}

/** The bearer token for this HTTP request, or null when the caller did not bind one. */
export function currentRequestToken(): string | null {
  return requestTokens.getStore() ?? null;
}

/** Binds the raw bearer token for the async work of one request. The value is not logged. */
export function bindRequestToken<T>(token: string, work: () => Promise<T>): Promise<T> {
  return requestTokens.run(token, work);
}

/**
 * One pooled request. The token lives only until COMMIT or ROLLBACK, and RESET
 * runs again before the connection returns to the pool.
 * Pass null when the request has no bearer token. Do not pass a user id.
 */
export async function withPooledSession<T>(
  pool: pg.Pool,
  token: string | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  sessionBearers.set(client, token ?? "");
  try {
    await clearAccessToken(client);
    await assertApplicationRole(client);
    await client.query("SET statement_timeout = '15s'");
    await prepareLocalAccess(client);
    await client.query("BEGIN");
    outerTransaction.add(client);
    await applyLocalAccessToken(client);
    try {
      const result = await work(client);
      await client.query("COMMIT");
      outerTransaction.delete(client);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      outerTransaction.delete(client);
      throw error;
    }
  } finally {
    sessionBearers.delete(client);
    sessionAssertions.delete(client);
    let destroy: Error | undefined;
    try {
      if (outerTransaction.has(client)) {
        outerTransaction.delete(client);
        await client.query("ROLLBACK");
      }
      await clearAccessToken(client);
    } catch (error) {
      destroy = error instanceof Error ? error : new Error("Database session cleanup failed.");
    } finally {
      client.release(destroy);
    }
  }
}
