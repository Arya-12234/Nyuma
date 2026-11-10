import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envFilePaths, loadConfig, loadEnvFile, loadMigrationConfig, type AppConfig } from "../src/config/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function localConfig(env: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test", ...env });
}

describe("configuration", () => {
  it("starts without a database and refuses remote or placeholder URLs", () => {
    expect(localConfig().databaseUrl).toBeNull();
    expect(localConfig().host).toBe("127.0.0.1");
    expect(localConfig().port).toBe(8787);
    expect(localConfig({ DATABASE_URL: "postgres://postgres:secret@127.0.0.1:5432/nyuma" }).databaseUrl).toContain("127.0.0.1");
    expect(localConfig({ DATABASE_URL: "postgresql://postgres:secret@localhost/nyuma" }).databaseUrl).toContain("localhost");
    expect(() => localConfig({ DATABASE_URL: "postgres://postgres:secret@[::1]:5432/nyuma" })).not.toThrow();
    expect(() => localConfig({ DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:5432/nyuma" })).toThrow(/placeholder/);
    expect(() => localConfig({ DATABASE_URL: "postgres://postgres:secret@db.example.com:5432/nyuma" })).toThrow(/non-local/);
    expect(() => localConfig({ DATABASE_URL: "https://example.supabase.co" })).toThrow(/postgres or postgresql/);
    expect(() => localConfig({ HOST: "0.0.0.0" })).toThrow(/HOST/);
    expect(() => localConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(localConfig({ APP_DATABASE_URL: "postgres://nyuma_app_login:secret@127.0.0.1:5432/nyuma" }).appDatabaseUrl).toContain("127.0.0.1");
    expect(() => localConfig({ APP_DATABASE_URL: "postgres://nyuma_app_login:secret@db.example.com/nyuma" })).toThrow(/non-local/);
    expect(localConfig({
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_ANON_KEY: "publishable-test-value",
    }).supabaseUrl).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(() => localConfig({ SUPABASE_URL: "https://your-project-ref.supabase.co" })).toThrow(/placeholder/);
    expect(() => localConfig({ SUPABASE_URL: "https://evil.example/auth" })).toThrow(/supabase.co/);
    expect(() => localConfig({ SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key" })).toThrow(/service-role/);
    expect(() => localConfig({ ASSERTION_HMAC_KEY: "not-a-real-key" })).toThrow(/assertion signing key/);
    expect(() => localConfig({ ASSERTION_HMAC_KEY_FILE: "C:\\keys\\assertion.key" })).toThrow(/assertion signing key/);
    expect(localConfig({ ASSERTION_HMAC_KEY: "  " }).databaseUrl).toBeNull();
    expect(localConfig().signerCredential).toBeNull();
    expect(localConfig().identityMode).toBe("local-hs256-test");
    expect(loadConfig({
      NYUMA_IDENTITY_MODE: "signer",
      SIGNER_CLIENT_CREDENTIAL: "local-test-client-credential-32b",
    }).signerUrl).toBe("http://127.0.0.1:8791");
    expect(() => localConfig({ SIGNER_CLIENT_CREDENTIAL: "too-short" })).toThrow(/32 bytes/);
    expect(() => localConfig({ SIGNER_URL: "http://10.0.0.8:8791" })).toThrow(/127\.0\.0\.1:8791/);
    expect(() => localConfig({ SIGNER_URL: "http://127.0.0.1:8791", ASSERTION_HMAC_KEY: "not-a-real-key" })).toThrow(/assertion signing key/);
  });

  it("permits local HS256 mode only for an explicit test or development environment", () => {
    const credential = "local-test-client-credential-32b";
    const local = { NYUMA_IDENTITY_MODE: "local-hs256-test" };
    expect(loadConfig({ ...local, NODE_ENV: "test" }).identityMode).toBe("local-hs256-test");
    expect(loadConfig({ ...local, NODE_ENV: "development" }).identityMode).toBe("local-hs256-test");
    expect(() => loadConfig(local)).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "" })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "   " })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "production" })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "Production" })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "staging" })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({ ...local, NODE_ENV: "Test" })).toThrow(/permitted only when NODE_ENV is test or development/);
    expect(() => loadConfig({})).toThrow(/NYUMA_IDENTITY_MODE is required/);
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(/NYUMA_IDENTITY_MODE is required/);
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow(/NYUMA_IDENTITY_MODE is required/);
    expect(() => loadConfig({ NYUMA_IDENTITY_MODE: "   " })).toThrow(/NYUMA_IDENTITY_MODE is required/);
    expect(() => loadConfig({ NYUMA_IDENTITY_MODE: "bearer" })).toThrow(/must be signer or local-hs256-test/);
    expect(() => loadConfig({ NYUMA_IDENTITY_MODE: credential })).toThrow(/must be signer or local-hs256-test/);
    expect(() => loadConfig({ NODE_ENV: "test", NYUMA_IDENTITY_MODE: "signer" })).toThrow(/SIGNER_CLIENT_CREDENTIAL/);
    expect(() => loadConfig({ NYUMA_IDENTITY_MODE: "signer" })).toThrow(/SIGNER_CLIENT_CREDENTIAL/);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/Production requires NYUMA_IDENTITY_MODE=signer/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      NYUMA_IDENTITY_MODE: "signer",
    })).toThrow(/Production requires NYUMA_IDENTITY_MODE=signer/);
    for (const nodeEnv of [undefined, "test", "development", "production"]) {
      const signer = loadConfig({
        NODE_ENV: nodeEnv,
        NYUMA_IDENTITY_MODE: "signer",
        SIGNER_CLIENT_CREDENTIAL: credential,
      });
      expect(signer.identityMode).toBe("signer");
      expect(signer.signerUrl).toBe("http://127.0.0.1:8791");
      expect(signer.signerCredential).toBe(credential);
    }
  });

  it("lets the migration command read a local database URL without an identity mode", () => {
    const url = "postgres://postgres:secret@127.0.0.1:5432/nyuma";
    expect(loadMigrationConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
    expect(loadMigrationConfig({
      DATABASE_URL: url,
      NYUMA_IDENTITY_MODE: "local-hs256-test",
    }).databaseUrl).toBe(url);
    expect(() => loadConfig({ DATABASE_URL: url })).toThrow(/NYUMA_IDENTITY_MODE is required/);
    const source = readFileSync(path.join(root, "server/src/db/migrate.ts"), "utf8");
    expect(source).toContain("loadMigrationConfig(env)");
    expect(source).not.toContain("loadConfig(");
  });

  it("reads an env file without printing it", () => {
    expect(loadEnvFile("# comment\nDATABASE_URL=postgres://localhost/nyuma\n\nPORT=8787\n")).toEqual({
      DATABASE_URL: "postgres://localhost/nyuma",
      PORT: "8787",
    });
  });

  it("keeps the example free of real credentials and ignores real env files", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(example).toContain("change-me");
    expect(example).toContain("127.0.0.1");
    expect(example).toContain("https://your-project-ref.supabase.co");
    expect(example).toContain("your-anon-key");
    expect(example).not.toContain("eyJ");
    expect(example).toContain("Do not set SUPABASE_SERVICE_ROLE_KEY");
    expect(example.toLowerCase()).not.toMatch(/supabase_service_role_key\s*=/);
    expect(example).toContain("NODE_ENV=development");
    expect(example).toContain("NYUMA_IDENTITY_MODE=local-hs256-test");
    expect(example).toContain("not production-safe");
    expect(example).toContain("SIGNER_CLIENT_CREDENTIAL=");
    expect(example).not.toMatch(/ASSERTION_HMAC_KEY\s*=/);
    expect(example).not.toMatch(/ASSERTION_HMAC_KEY_FILE\s*=/);
    const signerExample = readFileSync(path.join(root, ".env.signer.example"), "utf8");
    expect(signerExample).toContain("ASSERTION_HMAC_KEY=");
    expect(signerExample).toContain("SIGNER_CLIENT_CREDENTIAL=");
    expect(signerExample).not.toContain("eyJ");
    expect(signerExample).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
    expect(envFilePaths().every((filePath) => path.basename(filePath) === ".env")).toBe(true);
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".env.signer");
    expect(ignore).toContain("!.env.example");
    expect(ignore).toContain("!.env.signer.example");
    const frontend = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(frontend.scripts.dev).toBe("vite");
    expect(frontend.scripts.test).toBe("vitest run");
    expect(frontend.scripts.build).toBe("tsc --noEmit && vite build");
  });
});
