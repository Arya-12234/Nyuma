import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult } from "pg";
import pg from "pg";
import { mintAssertion } from "../src/assertion/canonical.js";
import { AssertionClientError } from "../src/assertion/client.js";
import { IDENTITY_MODE_LOCAL_HS256_TEST, IDENTITY_MODE_SIGNER } from "../src/config/env.js";
import { configureAssertionSource, configureIdentityMode, withPooledSession } from "../src/db/session.js";
import { runTransaction } from "../src/db/transaction.js";

const bearer = "original-supabase-access-token";
const subject = "58060e06-2f2a-4645-a8de-b4cc00414533";

afterEach(() => {
  configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
  configureAssertionSource(null);
});

describe("assertion transaction lifecycle", () => {
  it("stores a fresh transaction-local assertion and clears it after commit, rollback, and reuse", async () => {
    const client = fakeClient();
    const minted: string[] = [];
    configureIdentityMode(IDENTITY_MODE_SIGNER);
    configureAssertionSource(async (token) => {
      expect(token).toBe(bearer);
      const wire = wireFor(minted.length + 1);
      minted.push(wire);
      return wire;
    });
    await withPooledSession(poolOf(client), bearer, async () => "committed");
    const applied = localValues(client);
    expect(applied).toEqual([minted[0]]);
    expect(applied[0]).not.toBe(bearer);
    expect(client.statements.some((call) => call.statement === "RESET nyuma.access_token")).toBe(true);
    expect(client.statements.some((call) => call.statement.includes("set_config('nyuma.access_token', '', false)"))).toBe(true);

    client.calls.length = 0;
    await expect(withPooledSession(poolOf(client), bearer, async () => {
      throw new Error("application rejected the write");
    })).rejects.toThrow(/application rejected/);
    expect(client.statements.some((call) => call.statement === "ROLLBACK")).toBe(true);
    expect(client.statements.at(-2)?.statement).toContain("set_config('nyuma.access_token', '', false)");
    expect(client.statements.at(-1)?.statement).toBe("RESET nyuma.access_token");

    client.calls.length = 0;
    await withPooledSession(poolOf(client), null, async () => "empty");
    expect(localValues(client)).toEqual([""]);
    expect(minted).toHaveLength(2);
  });

  it("asks for a new assertion after a deadlock and does not run work when the signer fails", async () => {
    const client = fakeClient();
    const seen: string[] = [];
    configureIdentityMode(IDENTITY_MODE_SIGNER);
    configureAssertionSource(async () => {
      const wire = wireFor(seen.length + 1);
      seen.push(wire);
      return wire;
    });
    let attempts = 0;
    await withPooledSession(poolOf(client), bearer, (connection) => runTransaction(connection, async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return "saved";
    }));
    expect(attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(localValues(client)).toEqual([seen[0], seen[0], seen[1]]);

    const blocked = fakeClient();
    let ran = false;
    configureIdentityMode(IDENTITY_MODE_SIGNER);
    configureAssertionSource(async () => {
      throw new Error(`signer down ${bearer}`);
    });
    await expect(withPooledSession(poolOf(blocked), bearer, async () => {
      ran = true;
      return "no";
    })).rejects.toThrow(AssertionClientError);
    expect(ran).toBe(false);
    expect(blocked.statements.some((call) => call.statement === "BEGIN")).toBe(false);
    expect(localValues(blocked)).toEqual([]);
    expect(JSON.stringify(blocked.calls)).not.toContain(bearer);
  });

  it("writes the raw bearer only in local HS256 test mode", async () => {
    const client = fakeClient();
    configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
    configureAssertionSource(async () => wireFor(1));
    await withPooledSession(poolOf(client), bearer, async () => "local");
    expect(localValues(client)).toEqual([bearer]);
  });

  it("does not let the caller choose the assertion", async () => {
    const client = fakeClient();
    const supplied = wireFor(9);
    configureIdentityMode(IDENTITY_MODE_SIGNER);
    configureAssertionSource(async (token) => {
      expect(token).toBe(bearer);
      return wireFor(4);
    });
    await withPooledSession(poolOf(client), bearer, async () => supplied);
    expect(localValues(client)).toEqual([wireFor(4)]);
    expect(localValues(client)[0]).not.toBe(supplied);
  });
});

function wireFor(iatOffset: number): string {
  return mintAssertion({
    key: Buffer.alloc(32, 4),
    kid: "test-key",
    sub: subject,
    iat: 1762684200 + iatOffset,
  });
}

function poolOf(client: ReturnType<typeof fakeClient>): pg.Pool {
  return { connect: async () => client } as unknown as pg.Pool;
}

function localValues(client: ReturnType<typeof fakeClient>): unknown[] {
  return client.calls
    .filter((call) => call.statement.includes("set_config('nyuma.access_token', $1, true)"))
    .map((call) => call.params?.[0]);
}

function fakeClient(): {
  calls: { statement: string; params?: unknown[] }[];
  statements: { statement: string; params?: unknown[] }[];
  query: (statement: string, params?: unknown[]) => Promise<QueryResult>;
  release: () => void;
} {
  const calls: { statement: string; params?: unknown[] }[] = [];
  return {
    calls,
    get statements() {
      return calls;
    },
    async query(statement: string, params?: unknown[]) {
      calls.push({ statement, params });
      if (statement.includes("pg_has_role")) {
        return { rows: [{ rolsuper: false, blocked: false, app: true }] } as unknown as QueryResult;
      }
      return { rows: [] } as unknown as QueryResult;
    },
    release() {
      return undefined;
    },
  };
}
