import { assertApplicationRole } from "./applicationRole.js";
import { createClient } from "./client.js";

export type DatabaseReadiness = "ready" | "not-configured" | "unavailable";

export async function databaseReadiness(databaseUrl: string | null): Promise<DatabaseReadiness> {
  if (!databaseUrl) return "not-configured";
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await client.query("SELECT 1");
    return "ready";
  } catch {
    return "unavailable";
  } finally {
    try {
      await client.end();
    } catch {
      // The readiness result is already decided.
    }
  }
}

/** Connects as the ordinary application role and rejects a superuser, operator, provisioner, or function-owner session. */
export async function applicationReadiness(databaseUrl: string | null): Promise<DatabaseReadiness> {
  if (!databaseUrl) return "not-configured";
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await client.query("SELECT 1");
    await assertApplicationRole(client);
    return "ready";
  } catch {
    return "unavailable";
  } finally {
    try {
      await client.end();
    } catch {
      // The readiness result is already decided.
    }
  }
}
