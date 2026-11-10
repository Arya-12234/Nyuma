import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthRejected, type AuthGateway, type AuthSession } from "../auth/supabaseAuth.js";
import {
  AccountDisabled,
  AccountNotBootstrapped,
  InvalidRequest,
  WorkspaceNotAssigned,
  ordinaryRoles,
  type AccountView,
  type IdentityStore,
  type RoleRequestHistory,
  type RoleRequestSubmission,
} from "../auth/identity.js";
import { bearerToken, TokenError, type VerifiedIdentity } from "../auth/tokens.js";
import type { AppConfig } from "../config/env.js";
import { ApplicationRoleError } from "../db/applicationRole.js";
import { bindRequestToken } from "../db/session.js";
import { applicationReadiness } from "../db/ready.js";
import type { RoleRequestLimiter } from "./rateLimit.js";
import { coordinationResponse, isCoordinationRoute } from "./coordinationRoutes.js";
import type { CoordinationStore } from "../coordination/store.js";
import { Conflict, RecordNotFound, RelationshipConflict, RoleNotGranted } from "../coordination/errors.js";

export interface AppDependencies {
  config: AppConfig;
  verifyToken: (token: string) => Promise<VerifiedIdentity>;
  auth: AuthGateway | null;
  identities: IdentityStore | null;
  coordination: CoordinationStore | null;
  rateLimiter: RoleRequestLimiter;
}

export async function dispatch(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const token = presentedBearer(req.headers.authorization);
  if (token === null) {
    await route(req, res, deps);
    return;
  }
  await bindRequestToken(token, () => route(req, res, deps));
}

async function route(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const path = req.url?.split("?")[0];
  try {
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true, service: "nyuma-api" });
      return;
    }
    if (req.method === "GET" && path === "/ready") {
      const database = await applicationReadiness(deps.config.appDatabaseUrl);
      send(res, database === "ready" ? 200 : 503, { ok: database === "ready", database });
      return;
    }
    if (req.method === "GET" && path === "/auth/health") {
      send(res, 200, {
        ok: true,
        auth: deps.config.supabaseUrl && deps.config.supabaseAnonKey ? "configured" : "not-configured",
        tokenVerification: deps.config.supabaseUrl ? "configured" : "not-configured",
      });
      return;
    }
    if (req.method === "POST" && path === "/auth/register") {
      await register(req, res, deps);
      return;
    }
    if (req.method === "POST" && path === "/auth/login") {
      await login(req, res, deps);
      return;
    }
    if (req.method === "POST" && path === "/auth/logout") {
      await logout(req, res, deps);
      return;
    }
    if (req.method === "POST" && path === "/auth/refresh") {
      await refresh(req, res, deps);
      return;
    }
    if (req.method === "GET" && path === "/me") {
      await currentAccount(req, res, deps);
      return;
    }
    if (req.method === "POST" && path === "/me/bootstrap") {
      await bootstrap(req, res, deps);
      return;
    }
    if (req.method === "PUT" && path === "/me/workspace") {
      await selectWorkspace(req, res, deps);
      return;
    }
    if (req.method === "POST" && path === "/me/role-requests") {
      await submitRoleRequests(req, res, deps);
      return;
    }
    if (req.method === "GET" && path === "/me/role-requests") {
      await listRoleRequests(req, res, deps);
      return;
    }
    if (path && isCoordinationRoute(path)) {
      const account = await activeAccount(req, deps);
      const result = await coordinationResponse(req.method ?? "GET", path, account, requireCoordination(deps), bodyFor(req.method, await readOptionalJson(req)));
      send(res, result.status, result.body);
      return;
    }
    send(res, 404, { ok: false, error: "not-found" });
  } catch (error) {
    const mapped = statusFor(error);
    if (mapped) {
      send(res, mapped.status, mapped.body);
      return;
    }
    console.error("request failed");
    send(res, 500, { ok: false, error: "request-failed" });
  }
}

async function register(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  if (!deps.auth) {
    send(res, 503, { ok: false, error: "auth-not-configured" });
    return;
  }
  const credentials = readCredentials(await readJsonObject(req));
  let result;
  try {
    result = await deps.auth.register(credentials.email, credentials.password);
  } catch (error) {
    if (error instanceof AuthRejected) {
      send(res, 400, { ok: false, error: "registration-rejected" });
      return;
    }
    throw error;
  }
  if ("confirmationRequired" in result) {
    send(res, 202, { ok: true, confirmationRequired: true });
    return;
  }
  send(res, 200, { ok: true, session: publicSession(result) });
}

async function login(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  if (!deps.auth) {
    send(res, 503, { ok: false, error: "auth-not-configured" });
    return;
  }
  const credentials = readCredentials(await readJsonObject(req));
  send(res, 200, { ok: true, session: publicSession(await deps.auth.login(credentials.email, credentials.password)) });
}

async function logout(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  if (!deps.auth) {
    send(res, 503, { ok: false, error: "auth-not-configured" });
    return;
  }
  const token = bearerToken(req.headers.authorization);
  await deps.verifyToken(token);
  await deps.auth.logout(token);
  send(res, 200, { ok: true });
}

async function refresh(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  if (!deps.auth) {
    send(res, 503, { ok: false, error: "auth-not-configured" });
    return;
  }
  const body = await readJsonObject(req);
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (!refreshToken || refreshToken.length > 4096) throw new RequestRejected();
  send(res, 200, { ok: true, session: publicSession(await deps.auth.refresh(refreshToken)) });
}

async function currentAccount(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const identity = await authenticated(req, deps);
  const store = requireStore(deps);
  const account = await store.findAccount(identity.authUserId);
  if (!account) throw new AccountNotBootstrapped();
  if (account.status !== "active") throw new AccountDisabled();
  send(res, 200, { ok: true, account: publicAccount(account) });
}

async function bootstrap(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const identity = await authenticated(req, deps);
  await readJsonObject(req);
  const account = await requireStore(deps).bootstrap(identity.authUserId);
  send(res, 200, { ok: true, account: publicAccount(account) });
}

async function selectWorkspace(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const identity = await authenticated(req, deps);
  const body = await readJsonObject(req);
  const role = typeof body.role === "string" ? body.role : "";
  if (!role) throw new RequestRejected();
  const account = await requireStore(deps).setActiveRole(identity.authUserId, role);
  send(res, 200, { ok: true, account: publicAccount(account) });
}

async function submitRoleRequests(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const identity = await authenticated(req, deps);
  const decision = deps.rateLimiter.consume(identity.authUserId, req.socket.remoteAddress ?? "unknown");
  if (!decision.allowed) {
    send(res, 429, { ok: false, error: "rate-limited" }, { "retry-after": String(decision.retryAfterSeconds) });
    return;
  }
  const store = requireStore(deps);
  const account = await store.findAccount(identity.authUserId);
  if (!account) throw new AccountNotBootstrapped();
  if (account.status !== "active") throw new AccountDisabled();
  const roles = readRoleNames(await readJsonObject(req));
  const requests = await store.submitRoleRequests(identity.authUserId, roles);
  send(res, 200, { ok: true, requests: requests.map(publicSubmission) });
}

async function listRoleRequests(req: IncomingMessage, res: ServerResponse, deps: AppDependencies): Promise<void> {
  const identity = await authenticated(req, deps);
  const store = requireStore(deps);
  const account = await store.findAccount(identity.authUserId);
  if (!account) throw new AccountNotBootstrapped();
  if (account.status !== "active") throw new AccountDisabled();
  const requests = await store.listRoleRequests(identity.authUserId);
  send(res, 200, { ok: true, requests: requests.map(publicHistory) });
}

async function activeAccount(req: IncomingMessage, deps: AppDependencies): Promise<AccountView> {
  const identity = await authenticated(req, deps);
  const account = await requireStore(deps).findAccount(identity.authUserId);
  if (!account) throw new AccountNotBootstrapped();
  if (account.status !== "active") throw new AccountDisabled();
  return account;
}

function requireCoordination(deps: AppDependencies): CoordinationStore {
  if (!deps.coordination) {
    const error = new Error("database-not-configured");
    error.name = "DatabaseNotConfigured";
    throw error;
  }
  return deps.coordination;
}

async function readOptionalJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== "POST" && req.method !== "PATCH") return {};
  return readJsonObject(req);
}

function bodyFor(method: string | undefined, body: Record<string, unknown>): Record<string, unknown> {
  return method === "POST" || method === "PATCH" ? body : {};
}

function presentedBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value, extra] = header.split(" ");
  if (scheme !== "Bearer" || !value || extra) return null;
  return value;
}

async function authenticated(req: IncomingMessage, deps: AppDependencies): Promise<VerifiedIdentity> {
  const token = bearerToken(req.headers.authorization);
  return deps.verifyToken(token);
}

function requireStore(deps: AppDependencies): IdentityStore {
  if (!deps.identities) {
    const error = new Error("database-not-configured");
    error.name = "DatabaseNotConfigured";
    throw error;
  }
  return deps.identities;
}

class RequestRejected extends Error {
  constructor() {
    super("invalid-request");
  }
}

function readRoleNames(body: Record<string, unknown>): string[] {
  const roles = body.roles;
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 10) throw new RequestRejected();
  if (!roles.every((role) => typeof role === "string" && ordinaryRoles.includes(role as (typeof ordinaryRoles)[number]))) {
    throw new RequestRejected();
  }
  return roles;
}

function publicAccount(account: AccountView): AccountView {
  return { id: account.id, status: account.status, roles: account.roles, activeRole: account.activeRole };
}

function publicSubmission(request: RoleRequestSubmission): RoleRequestSubmission {
  return {
    id: request.id,
    role: request.role,
    status: request.status,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt,
  };
}

function publicHistory(request: RoleRequestHistory): RoleRequestHistory {
  return {
    id: request.id,
    role: request.role,
    status: request.status,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt,
    decisionNote: request.decisionNote,
    granted: request.granted,
  };
}

function publicSession(session: AuthSession): AuthSession {
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) throw new RequestRejected();
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestRejected();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestRejected();
  return parsed as Record<string, unknown>;
}

function readCredentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || email.length > 320 || !email.includes("@") || /\s/.test(email) || !password || password.length > 1024) {
    throw new RequestRejected();
  }
  return { email, password };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function statusFor(error: unknown): { status: number; body: { ok: false; error: string } } | null {
  if (error instanceof TokenError) return { status: 401, body: { ok: false, error: "unauthenticated" } };
  if (error instanceof AuthRejected) return { status: 401, body: { ok: false, error: "invalid-credentials" } };
  if (error instanceof RequestRejected || error instanceof InvalidRequest) return { status: 400, body: { ok: false, error: "invalid-request" } };
  if (error instanceof AccountNotBootstrapped) return { status: 404, body: { ok: false, error: "account-not-bootstrapped" } };
  if (error instanceof AccountDisabled) return { status: 403, body: { ok: false, error: "account-disabled" } };
  if (error instanceof WorkspaceNotAssigned) return { status: 403, body: { ok: false, error: "workspace-not-assigned" } };
  if (error instanceof RoleNotGranted) return { status: 403, body: { ok: false, error: "role-not-granted" } };
  if (error instanceof RecordNotFound) return { status: 404, body: { ok: false, error: "not-found" } };
  if (error instanceof RelationshipConflict) return { status: 409, body: { ok: false, error: "relationship" } };
  if (error instanceof Conflict) return { status: 409, body: { ok: false, error: "conflict" } };
  if (error instanceof ApplicationRoleError) return { status: 503, body: { ok: false, error: "database-unavailable" } };
  if (error instanceof Error && error.name === "DatabaseNotConfigured") {
    return { status: 503, body: { ok: false, error: "database-not-configured" } };
  }
  return null;
}
