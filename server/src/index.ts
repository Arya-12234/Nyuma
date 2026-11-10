import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createPostgresIdentityStore } from "./auth/identity.js";
import { createPostgresCoordinationStore } from "./coordination/store.js";
import { createSupabaseAuthGateway } from "./auth/supabaseAuth.js";
import { requestAssertion } from "./assertion/client.js";
import { createConfiguredVerifier, TokenError } from "./auth/tokens.js";
import { IDENTITY_MODE_SIGNER, loadConfig, loadRuntimeEnv, type AppConfig } from "./config/env.js";
import { useIdentity } from "./db/session.js";
import { dispatch, type AppDependencies } from "./http/dispatch.js";
import { createRoleRequestLimiter } from "./http/rateLimit.js";

export function healthBody(): { ok: true; service: "nyuma-api" } {
  return { ok: true, service: "nyuma-api" };
}

export function createApp(deps: AppDependencies): Server {
  return createServer((req, res) => {
    void dispatch(req, res, deps);
  });
}

export function dependenciesFromConfig(
  config: AppConfig,
  overrides: Partial<AppDependencies> = {},
): AppDependencies {
  const verifyToken = overrides.verifyToken ?? createConfiguredVerifier(config) ?? (async () => {
    throw new TokenError("invalid");
  });
  const auth = overrides.auth !== undefined
    ? overrides.auth
    : config.supabaseUrl && config.supabaseAnonKey
      ? createSupabaseAuthGateway(config.supabaseUrl, config.supabaseAnonKey)
      : null;
  const identities = overrides.identities !== undefined
    ? overrides.identities
    : config.appDatabaseUrl
      ? createPostgresIdentityStore(config.appDatabaseUrl)
      : null;
  const coordination = overrides.coordination !== undefined
    ? overrides.coordination
    : config.appDatabaseUrl
      ? createPostgresCoordinationStore(config.appDatabaseUrl)
      : null;
  const rateLimiter = overrides.rateLimiter ?? createRoleRequestLimiter();
  return { config, verifyToken, auth, identities, coordination, rateLimiter };
}

export async function start(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<AppDependencies> = {},
): Promise<Server> {
  const config = overrides.config ?? loadConfig(env);
  const ownsIdentities = overrides.identities === undefined && Boolean(config.appDatabaseUrl);
  const ownsCoordination = overrides.coordination === undefined && Boolean(config.appDatabaseUrl);
  const deps = dependenciesFromConfig(config, overrides);
  const signerCredential = config.signerCredential;
  const restoreIdentity = useIdentity(
    config.identityMode,
    config.identityMode === IDENTITY_MODE_SIGNER && signerCredential
      ? (token) => requestAssertion(token, signerCredential)
      : null,
  );
  const server = createApp(deps);
  server.on("close", restoreIdentity);
  if (ownsIdentities || ownsCoordination) {
    server.on("close", () => {
      if (ownsIdentities) void deps.identities?.close();
      if (ownsCoordination) void deps.coordination?.close();
    });
  }
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => resolve());
  });
  return server;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isDirectRun()) {
  try {
    const env = await loadRuntimeEnv();
    const config = loadConfig(env);
    const server = await start(env, { config });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : config.port;
    console.log(`Nyuma API listening on ${config.host}:${port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The API could not start.");
    process.exit(1);
  }
}
