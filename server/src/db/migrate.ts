import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMigrationConfig, loadRuntimeEnv } from "../config/env.js";
import { connectClient } from "./client.js";

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const noTransactionMarker = "-- nyuma:no-transaction";

export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDirectory);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

export async function applyMigrations(databaseUrl: string): Promise<string[]> {
  const client = await connectClient(databaseUrl);
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const fileName of await migrationFiles()) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [fileName]);
      if (existing.rowCount) continue;
      const sql = await readFile(path.join(migrationsDirectory, fileName), "utf8");
      try {
        if (sql.includes(noTransactionMarker)) {
          for (const statement of statementsOutsideTransaction(sql)) {
            try {
              await client.query(statement);
            } catch (error) {
              if (!isDuplicateRole(error)) throw error;
            }
          }
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [fileName]);
        } else {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [fileName]);
          await client.query("COMMIT");
        }
        applied.push(fileName);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original migration error is the one to report.
        }
        throw error;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

function statementsOutsideTransaction(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function isDuplicateRole(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "42710");
}

function redact(message: string, databaseUrl: string): string {
  return message.split(databaseUrl).join("[redacted]");
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const env = await loadRuntimeEnv();
  let databaseUrl: string | null;
  try {
    databaseUrl = loadMigrationConfig(env).databaseUrl;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and point it at a local PostgreSQL database.");
    process.exit(1);
  }
  try {
    const applied = await applyMigrations(databaseUrl);
    if (applied.length === 0) console.log("Migrations already applied.");
    else console.log(`Applied ${applied.join(", ")}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message, databaseUrl));
    process.exit(1);
  }
}
