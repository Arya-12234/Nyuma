import type { ClientBase } from "pg";
import { applyLocalAccessToken, joinedTransaction, prepareLocalAccess } from "./session.js";

const retryableCodes = new Set(["40P01", "40001"]);

export function isRetryableTransactionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && retryableCodes.has(String(error.code)));
}

/**
 * Retries a transaction only after a deadlock (40P01) or a serialization failure (40001).
 * Validation failures, constraint failures, and permission errors are returned immediately.
 * When the pool helper already opened the transaction, the first attempt reuses the
 * assertion minted before BEGIN. A deadlock or serialization retry rolls back, asks
 * for a new assertion, and only then begins again. The setting is transaction-local.
 */
export async function runTransaction<T>(
  client: ClientBase,
  work: (client: ClientBase) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let deferCommit = joinedTransaction(client);
  let preparedForNextBegin = false;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!deferCommit) {
        if (!preparedForNextBegin) await prepareLocalAccess(client);
        preparedForNextBegin = false;
        await client.query("BEGIN");
      }
      await applyLocalAccessToken(client);
      const result = await work(client);
      if (!deferCommit) await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error is the one to report or retry.
      }
      last = error;
      if (!isRetryableTransactionError(error) || attempt === attempts) throw error;
      await prepareLocalAccess(client);
      preparedForNextBegin = true;
      if (joinedTransaction(client)) {
        await client.query("BEGIN");
        deferCommit = true;
      } else {
        deferCommit = false;
      }
    }
  }
  throw last;
}
