import { describe, expect, it } from "vitest";
import type { ClientBase, QueryResult } from "pg";
import { isRetryableTransactionError, runTransaction } from "../src/db/transaction.js";

describe("transaction retry", () => {
  it("retries a deadlock and does not retry a validation failure", async () => {
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const validation = Object.assign(new Error("Purchases would exceed the remaining agreed quantity."), { code: "P0001" });
    expect(isRetryableTransactionError(deadlock)).toBe(true);
    expect(isRetryableTransactionError(validation)).toBe(false);
    expect(isRetryableTransactionError(Object.assign(new Error("serialization"), { code: "40001" }))).toBe(true);

    let attempts = 0;
    const client = fakeClient();
    const value = await runTransaction(client, async () => {
      attempts += 1;
      if (attempts < 3) throw deadlock;
      return "saved";
    });
    expect(value).toBe("saved");
    expect(attempts).toBe(3);
    expect(client.statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(2);
    expect(client.statements.filter((statement) => statement === "COMMIT")).toHaveLength(1);
    expect(client.statements.some((statement) => statement.includes("set_config('nyuma.access_token', $1, true)"))).toBe(true);
    expect(client.statements.some((statement) => statement.includes("nyuma.user_id"))).toBe(false);

    const rejected = fakeClient();
    await expect(runTransaction(rejected, async () => {
      throw validation;
    })).rejects.toThrow(/agreed quantity/);
    expect(rejected.statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
  });
});

function fakeClient(): ClientBase & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async query(statement: string) {
      statements.push(statement);
      return { rows: [] } as unknown as QueryResult;
    },
  } as ClientBase & { statements: string[] };
}
