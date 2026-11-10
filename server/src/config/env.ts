import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PLACEHOLDER_MARKERS = ["change-me", "your-password", "your-key", "replace-me"];

/** Local HS256 tests. Permitted only when NODE_ENV is exactly test or development. */
export const IDENTITY_MODE_LOCAL_HS256_TEST = "local-hs256-test";
/** Every authenticated database transaction obtains a nya1 assertion from the signer. */
export const IDENTITY_MODE_SIGNER = "signer";

export type IdentityMode = typeof IDENTITY_MODE_LOCAL_HS256_TEST | typeof IDENTITY_MODE_SIGNER;

export interface AppConfig {
  host: string;
  port: number;
  /** Operator connection used by migrations. It is not the request connection. */
  databaseUrl: string | null;
  /** Ordinary API connection. It must inherit nyuma_app and must not be a superuser, operator, provisioner, or function owner. */
  appDatabaseUrl: string | null;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  supabaseJwtSecret: string | null;
  /** Loopback signer origin. Null when the API is not configured to mint assertions. */
  signerUrl: string | null;
  /** API-to-signer credential. It is not the HMAC key. */
  signerCredential: string | null;
  /**
   * Selects the database identity path. There is no implicit raw-bearer default.
   * local-hs256-test is not production-safe.
   */
  identityMode: IdentityMode;
}

/** Database URL checks used by the migration command. Identity mode is not read here. */
export interface MigrationConfig {
  databaseUrl: string | null;
}

export function loadMigrationConfig(env: Record<string, string | undefined>): MigrationConfig {
  return {
    databaseUrl: readDatabaseUrl(env.DATABASE_URL, "DATABASE_URL"),
  };
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  rejectServiceRole(env.SUPABASE_SERVICE_ROLE_KEY);
  rejectAssertionKey(env);
  return {
    host: readHost(env.HOST),
    port: readPort(env.PORT),
    databaseUrl: readDatabaseUrl(env.DATABASE_URL, "DATABASE_URL"),
    appDatabaseUrl: readDatabaseUrl(env.APP_DATABASE_URL, "APP_DATABASE_URL"),
    supabaseUrl: readSupabaseUrl(env.SUPABASE_URL),
    supabaseAnonKey: readSecret(env.SUPABASE_ANON_KEY, "SUPABASE_ANON_KEY"),
    supabaseJwtSecret: readSecret(env.SUPABASE_JWT_SECRET, "SUPABASE_JWT_SECRET"),
    signerUrl: readSignerUrl(env.SIGNER_URL, env.SIGNER_CLIENT_CREDENTIAL),
    signerCredential: readSignerCredential(env.SIGNER_CLIENT_CREDENTIAL),
    identityMode: readIdentityMode(env),
  };
}

export function loadEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/** Process environment wins over a file. A missing file leaves the base environment unchanged. */
export async function readOptionalEnvFile(
  filePath: string,
  base: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  try {
    const text = await readFile(filePath, "utf8");
    return { ...loadEnvFile(text), ...base };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...base };
    throw error;
  }
}

export function envFilePaths(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, "../../.env"), path.resolve(here, "../../../.env")];
}

export async function loadRuntimeEnv(
  base: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  let current = { ...base };
  for (const filePath of envFilePaths()) {
    current = await readOptionalEnvFile(filePath, current);
  }
  return current;
}

function readHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      "HOST must be 127.0.0.1 or localhost. This milestone does not expose the API on a public interface.",
    );
  }
  return host;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8787;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("PORT must be a whole number from 0 to 65535.");
  }
  const port = Number(value.trim());
  if (port > 65535) throw new Error("PORT must be a whole number from 0 to 65535.");
  return port;
}

function rejectServiceRole(value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") {
    throw new Error("This API does not accept a Supabase service-role key. Remove SUPABASE_SERVICE_ROLE_KEY.");
  }
}

const SIGNER_ORIGIN = "http://127.0.0.1:8791";

function readSignerUrl(value: string | undefined, credential: string | undefined): string | null {
  if (isSet(value) && value?.trim() !== SIGNER_ORIGIN) {
    throw new Error("The signer URL must be http://127.0.0.1:8791.");
  }
  return isSet(credential) ? SIGNER_ORIGIN : null;
}

function readSignerCredential(value: string | undefined): string | null {
  if (!isSet(value) || value === undefined) return null;
  const credential = value.trim();
  if (Buffer.byteLength(credential, "utf8") < 32) {
    throw new Error("The signer client credential must be at least 32 bytes.");
  }
  return credential;
}

function readIdentityMode(env: Record<string, string | undefined>): IdentityMode {
  const mode = env.NYUMA_IDENTITY_MODE?.trim() ?? "";
  const nodeEnv = env.NODE_ENV?.trim() ?? "";
  const production = nodeEnv.toLowerCase() === "production";
  if (mode === "") {
    throw new Error(
      production
        ? "Production requires NYUMA_IDENTITY_MODE=signer and SIGNER_CLIENT_CREDENTIAL."
        : "NYUMA_IDENTITY_MODE is required.",
    );
  }
  if (mode !== IDENTITY_MODE_SIGNER && mode !== IDENTITY_MODE_LOCAL_HS256_TEST) {
    throw new Error("NYUMA_IDENTITY_MODE must be signer or local-hs256-test.");
  }
  if (mode === IDENTITY_MODE_LOCAL_HS256_TEST) {
    if (nodeEnv !== "test" && nodeEnv !== "development") {
      throw new Error("local-hs256-test is permitted only when NODE_ENV is test or development.");
    }
    return mode;
  }
  if (!isSet(env.SIGNER_CLIENT_CREDENTIAL)) {
    throw new Error(
      production
        ? "Production requires NYUMA_IDENTITY_MODE=signer and SIGNER_CLIENT_CREDENTIAL."
        : "signer mode requires SIGNER_CLIENT_CREDENTIAL.",
    );
  }
  return IDENTITY_MODE_SIGNER;
}

function rejectAssertionKey(env: Record<string, string | undefined>): void {
  if (isSet(env.ASSERTION_HMAC_KEY) || isSet(env.ASSERTION_HMAC_KEY_FILE)) {
    throw new Error("This API does not accept the assertion signing key. Remove it from the API environment.");
  }
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function readSecret(value: string | undefined, name: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  if (PLACEHOLDER_MARKERS.some((marker) => trimmed.toLowerCase().includes(marker))) {
    throw new Error(`${name} still contains a placeholder.`);
  }
  return trimmed;
}

function readSupabaseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker)) || lower.includes("your-project-ref")) {
    throw new Error("SUPABASE_URL still contains a placeholder.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("SUPABASE_URL must be an https Supabase Auth URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("SUPABASE_URL must use https.");
  if (parsed.username || parsed.password) throw new Error("SUPABASE_URL must not include credentials.");
  if (!/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)) {
    throw new Error(
      "SUPABASE_URL must be a https://<project-ref>.supabase.co address. This process does not use that URL as a database connection.",
    );
  }
  return parsed.origin;
}

function readDatabaseUrl(value: string | undefined, name: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) {
    throw new Error(`${name} still contains a placeholder. Replace it with a local PostgreSQL URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must use the postgres or postgresql scheme.`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      "Refusing a non-local database host. This milestone does not connect to Supabase or any production database.",
    );
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    throw new Error(`${name} must include a database name.`);
  }
  return trimmed;
}
