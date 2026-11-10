import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const rollbackDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/rollback");
const rollback012Path = path.resolve(rollbackDirectory, "012_local_hs256_default_off_rollback.sql");
const rollback013Path = path.resolve(rollbackDirectory, "013_rls_predicates_rollback.sql");
const probeVersions = ["100_later.sql", "1000_later.sql", "not-a-version", "!ignored.sql"];

let admin: Client;

function checkOnlyGuard(source: string, target: number): string {
  const match = source.match(/DO \$\$[\s\S]*?\r?\n\$\$;/);
  if (!match) throw new Error("Rollback guard block is missing.");
  const block = match[0];
  if (/\b(DROP|DELETE|CREATE|ALTER|INSERT|UPDATE|GRANT|REVOKE)\b/i.test(block)) {
    throw new Error("Refusing to execute a rollback block that changes the database.");
  }
  if (!block.includes(`v_migration_target constant integer := ${target};`)) {
    throw new Error(`Expected the migration ${target} guard.`);
  }
  return block;
}

function orderLoop(source: string): string {
  const start = source.indexOf("  FOR v_migration_version IN");
  const end = source.indexOf("  END LOOP;", start);
  if (start < 0 || end < 0) throw new Error("Numeric migration loop is missing.");
  return source.slice(start, end + "  END LOOP;".length);
}

function guardForTarget(loop: string, target: number): string {
  return `DO $$
DECLARE
  v_migration_version text;
  v_migration_prefix numeric;
  v_migration_target constant integer := ${target};
BEGIN
${loop}
END;
$$;`;
}

async function sqlFailure(work: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : String(error);
    return { code, message };
  }
  throw new Error("The statement succeeded.");
}

beforeAll(async () => {
  if (!databaseUrl || databaseUrl.trim() === "") throw new Error("DATABASE_URL is required.");
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    NYUMA_IDENTITY_MODE: "local-hs256-test",
  });
  if (!config.databaseUrl) throw new Error("DATABASE_URL did not validate as a local database.");
  const parsed = new URL(config.databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "5433" || parsed.pathname !== "/nyuma_dev") {
    throw new Error("Refusing a database other than 127.0.0.1:5433/nyuma_dev.");
  }
  admin = await connectClient(config.databaseUrl);
  const server = await admin.query<{ port: number; version: string }>(
    "SELECT inet_server_port() AS port, current_setting('server_version') AS version",
  );
  expect(server.rows[0]).toMatchObject({ port: 5433, version: "18.4" });
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM public.schema_migrations WHERE version = ANY($1::text[])", [probeVersions]);
  } finally {
    await admin.end();
  }
});

describe("migration rollback ordering", () => {
  const source012 = readFileSync(rollback012Path, "utf8");
  const source013 = readFileSync(rollback013Path, "utf8");
  const guard012 = checkOnlyGuard(source012, 12);
  const guard = checkOnlyGuard(source013, 13);
  const prefixedGuard = guardForTarget(orderLoop(source013), 999);

  it("parses 010, 011, 012, and 100 as integers and ranks 100 later than 012", async () => {
    const parsed = await admin.query<{ version: string; prefix: number }>(
      `SELECT sample.version,
              substring(sample.version FROM '^([0-9]+)')::integer AS prefix
       FROM (VALUES
         ('010_stage_d_search_path.sql'),
         ('011_assertion_verifier.sql'),
         ('012_local_hs256_default_off.sql'),
         ('100_later.sql'),
         ('1000_later.sql'),
         ('999_previous.sql')
       ) AS sample(version)
       ORDER BY substring(sample.version FROM '^([0-9]+)')::integer`,
    );
    expect(parsed.rows.map((row) => [row.version, row.prefix])).toEqual([
      ["010_stage_d_search_path.sql", 10],
      ["011_assertion_verifier.sql", 11],
      ["012_local_hs256_default_off.sql", 12],
      ["100_later.sql", 100],
      ["999_previous.sql", 999],
      ["1000_later.sql", 1000],
    ]);
    const order = await admin.query<{ lexical_1000_before_999: boolean; numeric_1000_after_999: boolean }>(`
      SELECT '1000_later.sql' < '999_previous.sql' AS lexical_1000_before_999,
             substring('1000_later.sql' FROM '^([0-9]+)')::integer
               > substring('999_previous.sql' FROM '^([0-9]+)')::integer AS numeric_1000_after_999
    `);
    expect(order.rows[0]).toEqual({ lexical_1000_before_999: true, numeric_1000_after_999: true });
  });

  it("allows the 013 guard when 013 is the latest applied migration", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(guard);
      const recorded = await admin.query<{ version: string }>(
        "SELECT version FROM public.schema_migrations WHERE version = '013_rls_predicates.sql'",
      );
      expect(recorded.rows).toEqual([{ version: "013_rls_predicates.sql" }]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("makes the 012 guard refuse because 013 is recorded", async () => {
    await admin.query("BEGIN");
    try {
      const failure = await sqlFailure(() => admin.query(guard012));
      expect(failure.code).toBe("P0001");
      expect(failure.message).toContain("A later migration is recorded.");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("refuses 100_later.sql as a migration later than 013", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO public.schema_migrations (version) VALUES ('100_later.sql')");
      const failure = await sqlFailure(() => admin.query(guard));
      expect(failure.code).toBe("P0001");
      expect(failure.message).toContain("A later migration is recorded.");
    } finally {
      await admin.query("ROLLBACK");
    }
    const left = await admin.query("SELECT 1 FROM public.schema_migrations WHERE version = '100_later.sql'");
    expect(left.rowCount).toBe(0);
  });

  it("refuses 1000_later.sql when the same numeric loop targets 999", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO public.schema_migrations (version) VALUES ('1000_later.sql')");
      const failure = await sqlFailure(() => admin.query(prefixedGuard));
      expect(failure.code).toBe("P0001");
      expect(failure.message).toContain("A later migration is recorded.");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("refuses a malformed migration version instead of ignoring it", async () => {
    for (const version of ["not-a-version", "!ignored.sql"]) {
      await admin.query("BEGIN");
      try {
        await admin.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [version]);
        const failure = await sqlFailure(() => admin.query(guard));
        expect(failure.code).toBe("P0001");
        expect(failure.message).toContain(`Unparseable migration version: ${version}`);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    const left = await admin.query("SELECT version FROM public.schema_migrations WHERE version = ANY($1::text[])", [probeVersions]);
    expect(left.rows).toEqual([]);
  });

  it("refuses when migration 013 itself is not recorded", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("DELETE FROM public.schema_migrations WHERE version = '013_rls_predicates.sql'");
      const failure = await sqlFailure(() => admin.query(guard));
      expect(failure.code).toBe("P0001");
      expect(failure.message).toContain("013_rls_predicates.sql is not recorded.");
    } finally {
      await admin.query("ROLLBACK");
    }
    const restored = await admin.query(
      "SELECT 1 FROM public.schema_migrations WHERE version = '013_rls_predicates.sql'",
    );
    expect(restored.rowCount).toBe(1);
  });
});
