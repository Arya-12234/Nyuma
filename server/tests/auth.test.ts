import { request } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  AccountDisabled,
  AccountNotBootstrapped,
  InvalidRequest,
  WorkspaceNotAssigned,
  type AccountView,
  type IdentityStore,
  type OrdinaryRole,
  type RoleRequestSubmission,
} from "../src/auth/identity.js";
import { AuthRejected, type AuthGateway, type AuthSession, type RegistrationResult } from "../src/auth/supabaseAuth.js";
import { generateKeyPair, SignJWT } from "jose";
import { signTestToken, verifyAccessToken, type TokenCheck } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { createRoleRequestLimiter, type RoleRequestLimiter } from "../src/http/rateLimit.js";
import { start } from "../src/index.js";

const secret = new TextEncoder().encode("local-test-secret-not-a-supabase-project");
const otherSecret = new TextEncoder().encode("different-local-test-secret-value");
const issuer = "https://example-project.supabase.co/auth/v1";
const audience = "authenticated";
const authUserId = "11111111-1111-4111-8111-111111111111";
const otherAuthUserId = "22222222-2222-4222-8222-222222222222";
const anonKey = "publishable-test-value";
const jwtSecret = "jwt-signing-secret-for-config-only";
const check: TokenCheck = { issuer, audience, keys: secret, algorithms: ["HS256"] };

function signedRole(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

describe("token verification, local keys, no Supabase project", () => {
  it("rejects missing, malformed, unsigned, expired, and mis-issued tokens, and accepts a signed one", async () => {
    await expect(verifyAccessToken("not-a-token", check)).rejects.toThrow(/malformed|invalid/);
    await expect(verifyAccessToken("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", check)).rejects.toThrow(/invalid|malformed/);
    const forged = await signTestToken(otherSecret, { subject: authUserId, issuer, audience, expiresIn: "10m" });
    await expect(verifyAccessToken(forged, check)).rejects.toThrow(/invalid/);
    const expired = await signTestToken(secret, {
      subject: authUserId,
      issuer,
      audience,
      expiresIn: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(verifyAccessToken(expired, check)).rejects.toThrow(/expired/);
    const wrongIssuer = await signTestToken(secret, {
      subject: authUserId,
      issuer: "https://other-project.supabase.co/auth/v1",
      audience,
      expiresIn: "10m",
    });
    await expect(verifyAccessToken(wrongIssuer, check)).rejects.toThrow(/issuer/);
    const wrongAudience = await signTestToken(secret, { subject: authUserId, issuer, audience: "anon", expiresIn: "10m" });
    await expect(verifyAccessToken(wrongAudience, check)).rejects.toThrow(/audience/);
    const service = await signTestToken(secret, {
      subject: authUserId,
      issuer,
      audience,
      expiresIn: "10m",
      extra: { role: "service_role" },
    });
    await expect(verifyAccessToken(service, check)).rejects.toThrow(/invalid/);
    const valid = await signTestToken(secret, {
      subject: authUserId,
      issuer,
      audience,
      expiresIn: "10m",
      extra: { user_metadata: { role: "administrator" }, app_metadata: { role: "administrator" } },
    });
    await expect(verifyAccessToken(valid, check)).resolves.toEqual({ authUserId });
  });

  it("accepts a lowercase UUID and rejects uppercase and mixed-case subjects", async () => {
    const lowercase = "58060e06-2f2a-4645-a8de-b4cc00414533";
    const accepted = await signTestToken(secret, { subject: lowercase, issuer, audience, expiresIn: "10m" });
    await expect(verifyAccessToken(accepted, check)).resolves.toEqual({ authUserId: lowercase });
    const rejected = [
      "58060E06-2F2A-4645-A8DE-B4CC00414533",
      "58060e06-2f2a-4645-a8dE-b4cc00414533",
      "58060e06-2F2a-4645-a8de-b4cc00414533",
    ];
    for (const subject of rejected) {
      const token = await signTestToken(secret, { subject, issuer, audience, expiresIn: "10m" });
      await expect(verifyAccessToken(token, check)).rejects.toThrow(/invalid/);
    }
  });

  it("verifies an ES256 token with the matching public key", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const other = await generateKeyPair("ES256");
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(authUserId)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
    const asymmetric: TokenCheck = { issuer, audience, keys: publicKey, algorithms: ["ES256"] };
    await expect(verifyAccessToken(token, asymmetric)).resolves.toEqual({ authUserId });
    await expect(verifyAccessToken(token, { ...asymmetric, keys: other.publicKey })).rejects.toThrow(/invalid/);
  });

  it("requires role authenticated and rejects missing, anon, service_role, and malformed role claims", async () => {
    const accepted = await signedRole({ role: "authenticated" });
    await expect(verifyAccessToken(accepted, check)).resolves.toEqual({ authUserId });

    const rejected = [
      await signedRole({}),
      await signedRole({ role: "anon" }),
      await signedRole({ role: "service_role" }),
      await signedRole({ role: "" }),
      await signedRole({ role: "Authenticated" }),
      await signedRole({ role: " authenticated" }),
      await signedRole({ role: ["authenticated"] }),
      await signedRole({ role: null }),
      await signedRole({ role: 1 }),
    ];
    for (const token of rejected) {
      await expect(verifyAccessToken(token, check)).rejects.toThrow(/invalid/);
    }
  });
});

describe("mocked authentication HTTP", () => {
  it("does not grant a role from registration, metadata, or workspace selection, and hides secrets", async () => {
    const password = "hunter2-not-logged";
    const accessToken = await signTestToken(secret, { subject: authUserId, issuer, audience, expiresIn: "10m" });
    const store = memoryStore();
    const calls: string[] = [];
    const auth = mockGateway(calls);
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    const server = await listen(store, auth);
    const base = addressOf(server);
    try {
      const missing = await send(base, "GET", "/me");
      const malformed = await send(base, "GET", "/me", { authorization: "Bearer not-a-token" });
      const forged = await send(base, "GET", "/me", {
        authorization: `Bearer ${await signTestToken(otherSecret, { subject: authUserId, issuer, audience, expiresIn: "10m" })}`,
      });
      const expired = await send(base, "GET", "/me", {
        authorization: `Bearer ${await signTestToken(secret, { subject: authUserId, issuer, audience, expiresIn: Math.floor(Date.now() / 1000) - 60 })}`,
      });
      const wrongIssuer = await send(base, "GET", "/me", {
        authorization: `Bearer ${await signTestToken(secret, { subject: authUserId, issuer: "https://other-project.supabase.co/auth/v1", audience, expiresIn: "10m" })}`,
      });
      const wrongAudience = await send(base, "GET", "/me", {
        authorization: `Bearer ${await signTestToken(secret, { subject: authUserId, issuer, audience: "anon", expiresIn: "10m" })}`,
      });
      const health = await send(base, "GET", "/auth/health");
      const registered = await send(base, "POST", "/auth/register", undefined, {
        email: "farmer@example.com",
        password,
        role: "administrator",
        userId: otherAuthUserId,
        user_metadata: { role: "administrator" },
      });
      const bootstrapped = await send(base, "POST", "/me/bootstrap", { authorization: `Bearer ${accessToken}` }, {
        userId: otherAuthUserId,
        authUserId: otherAuthUserId,
        role: "administrator",
      });
      const repeated = await send(base, "POST", "/me/bootstrap", { authorization: `Bearer ${accessToken}` }, {
        userId: otherAuthUserId,
        role: "farmer",
      });
      const current = await send(base, "GET", "/me", { authorization: `Bearer ${accessToken}` });
      const workspace = await send(base, "PUT", "/me/workspace", { authorization: `Bearer ${accessToken}` }, { role: "administrator" });
      auth.login = async () => {
        throw new Error(`leaked ${password} ${accessToken}`);
      };
      const failedLogin = await send(base, "POST", "/auth/login", undefined, { email: "farmer@example.com", password });

      expect(missing).toEqual({ status: 401, body: { ok: false, error: "unauthenticated" } });
      expect(malformed.status).toBe(401);
      expect(forged.status).toBe(401);
      expect(expired.status).toBe(401);
      expect(wrongIssuer.status).toBe(401);
      expect(wrongAudience.status).toBe(401);
      expect(health.body).toEqual({ ok: true, auth: "configured", tokenVerification: "configured" });
      expect(JSON.stringify(health.body)).not.toContain(anonKey);
      expect(JSON.stringify(health.body)).not.toContain(jwtSecret);
      expect(calls).toEqual(["register"]);
      expect(store.links.size).toBe(1);
      expect(bootstrapped.status).toBe(200);
      expect(accountId(bootstrapped)).toBe(accountId(repeated));
      expect(accountId(current)).toBe(accountId(bootstrapped));
      expect(rolesOf(current)).toEqual([]);
      expect(workspace).toEqual({ status: 403, body: { ok: false, error: "workspace-not-assigned" } });
      expect(rolesOf(current)).toEqual([]);
      expect(registered.status).toBe(200);
      expect(JSON.stringify(failedLogin.body)).not.toContain(password);
      expect(JSON.stringify(failedLogin.body)).not.toContain(accessToken);
      expect(JSON.stringify(logs)).not.toContain(password);
      expect(JSON.stringify(logs)).not.toContain(accessToken);
      expect(logs.some((line) => line.includes("request failed"))).toBe(true);
    } finally {
      console.error = original;
      await close(server);
    }
  });

  it("keeps multiple assigned roles and rejects a workspace the account does not hold", async () => {
    const store = memoryStore();
    const account: AccountView = {
      id: randomUUID(),
      status: "active",
      roles: ["farmer", "trader"],
      activeRole: null,
    };
    store.links.set(authUserId, account);
    const token = await signTestToken(secret, { subject: authUserId, issuer, audience, expiresIn: "10m" });
    const server = await listen(store, mockGateway([]));
    try {
      const current = await send(addressOf(server), "GET", "/me", { authorization: `Bearer ${token}` });
      const selected = await send(addressOf(server), "PUT", "/me/workspace", { authorization: `Bearer ${token}` }, { role: "trader" });
      const rejected = await send(addressOf(server), "PUT", "/me/workspace", { authorization: `Bearer ${token}` }, { role: "buyer" });
      const admin = await send(addressOf(server), "PUT", "/me/workspace", { authorization: `Bearer ${token}` }, { role: "administrator" });
      expect(rolesOf(current)).toEqual(["farmer", "trader"]);
      expect(selected.status).toBe(200);
      expect((selected.body as { account: AccountView }).account.activeRole).toBe("trader");
      expect(rejected).toEqual({ status: 403, body: { ok: false, error: "workspace-not-assigned" } });
      expect(admin).toEqual({ status: 403, body: { ok: false, error: "workspace-not-assigned" } });
      expect(store.links.get(authUserId)?.roles).toEqual(["farmer", "trader"]);
    } finally {
      await close(server);
    }
  });

  it("rejects a disabled account", async () => {
    const store = memoryStore();
    store.links.set(authUserId, { id: randomUUID(), status: "suspended", roles: ["farmer"], activeRole: null });
    const token = await signTestToken(secret, { subject: authUserId, issuer, audience, expiresIn: "10m" });
    const server = await listen(store, mockGateway([]));
    try {
      const current = await send(addressOf(server), "GET", "/me", { authorization: `Bearer ${token}` });
      const again = await send(addressOf(server), "POST", "/me/bootstrap", { authorization: `Bearer ${token}` }, {});
      expect(current).toEqual({ status: 403, body: { ok: false, error: "account-disabled" } });
      expect(again).toEqual({ status: 403, body: { ok: false, error: "account-disabled" } });
    } finally {
      await close(server);
    }
  });

  it("limits role-request submissions without revealing another account", async () => {
    const store = memoryStore();
    const token = await signTestToken(secret, { subject: authUserId, issuer, audience, expiresIn: "10m" });
    const otherToken = await signTestToken(secret, { subject: otherAuthUserId, issuer, audience, expiresIn: "10m" });
    await store.bootstrap(authUserId);
    await store.bootstrap(otherAuthUserId);
    store.requests.set(otherAuthUserId, [{
      id: "other-request",
      role: "buyer",
      status: "pending",
      requestedAt: "2026-11-05T00:00:00.000Z",
      decidedAt: null,
      decisionNote: "private",
      granted: false,
    }]);
    let clock = 0;
    const limiter = createRoleRequestLimiter({
      now: () => clock,
      accountPerHour: 2,
      accountPerDay: 10,
      addressPerHour: 30,
    });
    const server = await listen(store, mockGateway([]), limiter);
    const base = addressOf(server);
    try {
      const unauthenticated = await send(base, "POST", "/me/role-requests", undefined, { roles: ["farmer"] });
      const invalid = await send(base, "POST", "/me/role-requests", { authorization: `Bearer ${token}` }, {
        roles: ["administrator"],
        authUserId: otherAuthUserId,
        userId: otherAuthUserId,
      });
      const first = await send(base, "POST", "/me/role-requests", { authorization: `Bearer ${token}` }, {
        roles: ["farmer", "farmer"],
        authUserId: otherAuthUserId,
        userId: otherAuthUserId,
      });
      const limited = await sendDetailed(base, "POST", "/me/role-requests", { authorization: `Bearer ${token}` }, { roles: ["trader"] });
      const history = await send(base, "GET", `/me/role-requests?authUserId=${otherAuthUserId}`, { authorization: `Bearer ${token}` });
      const other = await send(base, "POST", "/me/role-requests", { authorization: `Bearer ${otherToken}` }, { roles: ["buyer"] });
      expect(unauthenticated).toEqual({ status: 401, body: { ok: false, error: "unauthenticated" } });
      expect(invalid).toEqual({ status: 400, body: { ok: false, error: "invalid-request" } });
      expect(first.status).toBe(200);
      expect(JSON.stringify(first.body)).not.toContain(otherAuthUserId);
      expect(JSON.stringify(first.body)).not.toContain("other-request");
      expect(store.submittedFor).toEqual([authUserId, otherAuthUserId]);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ ok: false, error: "rate-limited" });
      expect(limited.retryAfter).toBe("60");
      expect(JSON.stringify(limited.body)).not.toContain(otherAuthUserId);
      expect(JSON.stringify(limited.body)).not.toContain("buyer");
      expect(history.status).toBe(200);
      expect(JSON.stringify(history.body)).not.toContain("other-request");
      expect(JSON.stringify(history.body)).not.toContain("private");
      expect(other.status).toBe(200);
    } finally {
      await close(server);
    }
  });
});

function memoryStore(): IdentityStore & {
  links: Map<string, AccountView>;
  requests: Map<string, Array<{
    id: string;
    role: "farmer" | "trader" | "buyer";
    status: "pending" | "approved" | "rejected";
    requestedAt: string;
    decidedAt: string | null;
    decisionNote: string | null;
    granted: boolean;
  }>>;
  submittedFor: string[];
} {
  const links = new Map<string, AccountView>();
  const requests = new Map<string, Array<{
    id: string;
    role: "farmer" | "trader" | "buyer";
    status: "pending" | "approved" | "rejected";
    requestedAt: string;
    decidedAt: string | null;
    decisionNote: string | null;
    granted: boolean;
  }>>();
  const submittedFor: string[] = [];
  return {
    links,
    requests,
    submittedFor,
    async bootstrap(authId) {
      const existing = links.get(authId);
      if (existing) {
        if (existing.status !== "active") throw new AccountDisabled();
        return existing;
      }
      const created: AccountView = { id: randomUUID(), status: "active", roles: [], activeRole: null };
      links.set(authId, created);
      return created;
    },
    async findAccount(authId) {
      return links.get(authId) ?? null;
    },
    async setActiveRole(authId, role) {
      const account = links.get(authId);
      if (!account || account.status !== "active" || !account.roles.includes(role as AccountView["roles"][number])) {
        throw new WorkspaceNotAssigned();
      }
      account.activeRole = role as AccountView["activeRole"];
      return account;
    },
    async submitRoleRequests(authId, roles) {
      submittedFor.push(authId);
      const account = links.get(authId);
      if (!account) throw new AccountNotBootstrapped();
      if (account.status !== "active") throw new AccountDisabled();
      const seen = new Set<string>();
      const created: RoleRequestSubmission[] = [];
      for (const roleName of roles) {
        if (roleName !== "farmer" && roleName !== "trader" && roleName !== "buyer") throw new InvalidRequest();
        const role: OrdinaryRole = roleName;
        if (seen.has(role)) continue;
        seen.add(role);
        if (account.roles.includes(role)) {
          created.push({ id: null, role, status: "granted", requestedAt: null, decidedAt: null });
          continue;
        }
        const row: {
          id: string;
          role: OrdinaryRole;
          status: "pending";
          requestedAt: string;
          decidedAt: null;
          decisionNote: null;
          granted: false;
        } = {
          id: randomUUID(),
          role,
          status: "pending",
          requestedAt: "2026-11-05T00:00:00.000Z",
          decidedAt: null,
          decisionNote: null,
          granted: false,
        };
        const history = requests.get(authId) ?? [];
        history.push(row);
        requests.set(authId, history);
        created.push({ id: row.id, role, status: "pending" as const, requestedAt: row.requestedAt, decidedAt: null });
      }
      return created;
    },
    async listRoleRequests(authId) {
      return requests.get(authId) ?? [];
    },
    async close() {
      links.clear();
    },
  };
}

function mockGateway(calls: string[]): AuthGateway & { login: AuthGateway["login"] } {
  const session: AuthSession = { accessToken: "mock-access-token", refreshToken: "mock-refresh-token", expiresAt: 1 };
  const gateway: AuthGateway = {
    async register(email, password): Promise<RegistrationResult> {
      calls.push("register");
      if (!email || !password) throw new AuthRejected();
      return session;
    },
    async login() {
      calls.push("login");
      return session;
    },
    async logout() {
      calls.push("logout");
    },
    async refresh() {
      calls.push("refresh");
      return session;
    },
  };
  return gateway;
}

async function listen(identities: IdentityStore, auth: AuthGateway, rateLimiter?: RoleRequestLimiter): Promise<Server> {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test", NYUMA_IDENTITY_MODE: "local-hs256-test",
    SUPABASE_URL: "https://example-project.supabase.co",
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_JWT_SECRET: jwtSecret,
  });
  return start({ HOST: "127.0.0.1", PORT: "0" }, {
    config,
    auth,
    identities,
    rateLimiter,
    verifyToken: (token) => verifyAccessToken(token, check),
  });
}

function addressOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not bind a port.");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function send(
  base: string,
  method: string,
  path: string,
  headers?: { authorization?: string },
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(`${base}${path}`, { method, headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendDetailed(
  base: string,
  method: string,
  path: string,
  headers?: { authorization?: string },
  body?: unknown,
): Promise<{ status: number; body: unknown; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(`${base}${path}`, { method, headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const retryAfter = response.headers["retry-after"];
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          retryAfter: Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function accountId(response: { body: unknown }): string {
  return (response.body as { account: AccountView }).account.id;
}

function rolesOf(response: { body: unknown }): string[] {
  return (response.body as { account: AccountView }).account.roles;
}
