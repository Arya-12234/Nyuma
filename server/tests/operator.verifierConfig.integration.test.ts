import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { loadConfig } from "../src/config/env.js";
import { connectClient } from "../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;

let adminUrl = "";
let admin: Client;

function loginUrl(adminDatabaseUrl: string, username: string): string {
  const parsed = new URL(adminDatabaseUrl);
  parsed.username = username;
  parsed.password = "";
  return parsed.toString();
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
  adminUrl = config.databaseUrl;
  admin = await connectClient(adminUrl);
  const server = await admin.query<{ port: number; version: string }>(
    "SELECT inet_server_port() AS port, current_setting('server_version') AS version",
  );
  expect(server.rows[0]).toMatchObject({ port: 5433, version: "18.4" });
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin.query("ROLLBACK");
    await admin.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id AND local_hs256_enabled");
  } finally {
    await admin.end();
  }
});

describe("authorized verifier configuration", () => {
  it("lets nyuma_owner change the HS256 flag only after SET ROLE nyuma_fn_identity", async () => {
    const owner = await connectClient(loginUrl(adminUrl, "nyuma_owner"));
    try {
      const before = await owner.query<{
        current_user: string;
        session_user: string;
        session_super: boolean;
        inherits: boolean;
        can_set: boolean;
        schema_usage: boolean;
      }>(`
        SELECT current_user,
               session_user,
               (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_super,
               pg_has_role(session_user, 'nyuma_fn_identity', 'USAGE') AS inherits,
               pg_has_role(session_user, 'nyuma_fn_identity', 'SET') AS can_set,
               has_schema_privilege(session_user, 'nyuma_private', 'USAGE') AS schema_usage
      `);
      expect(before.rows[0]).toEqual({
        current_user: "nyuma_owner",
        session_user: "nyuma_owner",
        session_super: false,
        inherits: false,
        can_set: true,
        schema_usage: false,
      });

      const denied = await sqlFailure(() =>
        owner.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true WHERE id"),
      );
      expect(denied.code).toBe("42501");

      await owner.query("BEGIN");
      try {
        await owner.query("SET ROLE nyuma_fn_identity");
        const switched = await owner.query<{ current_user: string; session_user: string; session_super: boolean }>(`
          SELECT current_user,
                 session_user,
                 (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_super
        `);
        expect(switched.rows[0]).toEqual({
          current_user: "nyuma_fn_identity",
          session_user: "nyuma_owner",
          session_super: false,
        });
        await owner.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true WHERE id");
        const enabled = await owner.query<{ local_hs256_enabled: boolean }>(
          "SELECT local_hs256_enabled FROM nyuma_private.verifier_config",
        );
        expect(enabled.rows[0]?.local_hs256_enabled).toBe(true);
        await owner.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = false WHERE id");
        const disabled = await owner.query<{ local_hs256_enabled: boolean }>(
          "SELECT local_hs256_enabled FROM nyuma_private.verifier_config",
        );
        expect(disabled.rows[0]?.local_hs256_enabled).toBe(false);
        await owner.query("RESET ROLE");
        const reset = await owner.query<{ current_user: string }>("SELECT current_user");
        expect(reset.rows[0]?.current_user).toBe("nyuma_owner");
        const deniedAgain = await sqlFailure(() =>
          owner.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true WHERE id"),
        );
        expect(deniedAgain.code).toBe("42501");
      } finally {
        await owner.query("ROLLBACK");
      }
    } finally {
      await owner.end();
    }

    const flag = await admin.query<{ local_hs256_enabled: boolean }>(
      "SELECT local_hs256_enabled FROM nyuma_private.verifier_config",
    );
    expect(flag.rows[0]?.local_hs256_enabled).toBe(false);
  });

  it("denies nyuma_api the flag and the identity-owner role", async () => {
    const api = await connectClient(loginUrl(adminUrl, "nyuma_api"));
    try {
      const identity = await api.query<{ current_user: string; session_super: boolean }>(`
        SELECT current_user,
               (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_super
      `);
      expect(identity.rows[0]).toEqual({ current_user: "nyuma_api", session_super: false });
      const update = await sqlFailure(() =>
        api.query("UPDATE nyuma_private.verifier_config SET local_hs256_enabled = true WHERE id"),
      );
      const assume = await sqlFailure(() => api.query("SET ROLE nyuma_fn_identity"));
      const read = await sqlFailure(() => api.query("SELECT local_hs256_enabled FROM nyuma_private.verifier_config"));
      expect(update.code).toBe("42501");
      expect(assume.code).toBe("42501");
      expect(read.code).toBe("42501");
    } finally {
      await api.end();
    }
  });
});
