import { describe, expect, it } from "vitest";
import { COORDINATION_STORAGE_KEY } from "../domain/coordinationDocument";
import { authorizeSection } from "./access";
import {
  accountMessage,
  accountPrincipal,
  chooseWorkspace,
  createSessionGate,
  holdSubmission,
  restoreThenLoad,
  roleRequestState,
  rolesForSubmission,
  screenForAccount,
  sendRoleRequests,
  workspaceRevoked,
  type AuthSession,
} from "./accountFlow";
import { readActor, writeSession, type KeyValueStore } from "./auth";
import { SCENARIO_STORAGE_KEY } from "./scenarioStorage";
import { NyumaApiError, type NyumaAccount, type NyumaApi, type RoleRequestHistory } from "./nyumaApi";

const session: AuthSession = { accessToken: "access-token-for-tests", email: "ada@example.com" };

function account(roles: NyumaAccount["roles"] = [], activeRole: NyumaAccount["activeRole"] = null, status: NyumaAccount["status"] = "active"): NyumaAccount {
  return { id: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3", status, roles, activeRole };
}

function history(role: RoleRequestHistory["role"], status: RoleRequestHistory["status"], granted = false): RoleRequestHistory {
  return {
    id: `${role}-${status}`,
    role,
    status,
    requestedAt: "2026-11-05T00:00:00.000Z",
    decidedAt: status === "pending" ? null : "2026-11-05T01:00:00.000Z",
    decisionNote: status === "rejected" ? "Not this season" : null,
    granted,
  };
}

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("account flow", () => {
  it("keeps a new account without granted roles on onboarding", () => {
    const pending = [history("farmer", "pending")];
    expect(screenForAccount(account())).toBe("onboarding");
    expect(roleRequestState("farmer", pending, [])).toBe("pending");
    expect(rolesForSubmission(["farmer", "administrator"], pending, [])).toEqual([]);
    expect(accountPrincipal(account(), session.email)).toBeNull();
  });

  it("treats approved roles as granted and rejected requests as open to submit again", () => {
    const granted = account(["farmer", "trader"]);
    expect(screenForAccount(granted)).toBe("choose-workspace");
    expect(screenForAccount({ ...granted, activeRole: "farmer" })).toBe("workspace");
    expect(roleRequestState("buyer", [history("buyer", "rejected")], granted.roles)).toBe("rejected");
    expect(rolesForSubmission(["buyer", "farmer"], [history("buyer", "rejected")], granted.roles)).toEqual(["buyer"]);
  });

  it("does not keep a revoked workspace", () => {
    const revoked = account(["trader"], "farmer");
    expect(workspaceRevoked(revoked)).toBe(true);
    expect(screenForAccount(revoked)).toBe("choose-workspace");
    expect(accountPrincipal(revoked, session.email)).toBeNull();
    const forged = {
      version: 1 as const,
      id: revoked.id,
      name: "Ada",
      email: session.email,
      role: "farmer" as const,
      sample: false as const,
      grantedRoles: ["trader" as const],
    };
    expect(readActor(forged)).toBeNull();
    expect(authorizeSection(forged, "#workspace").ok).toBe(false);
  });

  it("opens only a workspace the account response granted", () => {
    const principal = accountPrincipal(account(["farmer", "buyer"], "buyer"), session.email);
    const access = authorizeSection(principal, "#workspace");
    expect(access.ok).toBe(true);
    if (access.ok) expect(access.user.role).toBe("buyer");
  });

  it("bootstraps once, in order, and not before the session is restored", async () => {
    const calls: string[] = [];
    const api = fakeApi(calls, account(["farmer"], "farmer"));
    let release: (session: AuthSession | null) => void = () => undefined;
    const pending = restoreThenLoad(
      () => new Promise((resolve) => {
        release = resolve;
      }),
      api,
    );
    await Promise.resolve();
    expect(calls).toEqual([]);
    release(session);
    const result = await pending;
    expect(result.phase).toBe("workspace");
    expect(calls).toEqual(["bootstrap", "account", "requests"]);
  });

  it("stops after an expired session and does not repeat a bootstrap for the same sign-in", async () => {
    const calls: string[] = [];
    const api = fakeApi(calls, account(), 401);
    const expired = await restoreThenLoad(async () => session, api);
    expect(expired.phase).toBe("signed-out");
    expect(expired.failure).toBe("unauthenticated");
    expect(calls).toEqual(["bootstrap"]);

    const gate = createSessionGate();
    expect(gate.claim(session)).toBe("load");
    expect(gate.claim(session)).toBe("skip");
    expect(gate.claim({ ...session, accessToken: "refreshed-token" })).toBe("refresh");
    expect(gate.claim(null)).toBe("signed-out");
    const lock = { held: false };
    expect(holdSubmission(lock)).toBe(true);
    expect(holdSubmission(lock)).toBe(false);
  });

  it("handles a workspace rejection from the API and a rate-limited request", async () => {
    const calls: string[] = [];
    let workspaceCalls = 0;
    const api: NyumaApi = {
      async bootstrap() {
        calls.push("bootstrap");
        return account();
      },
      async account() {
        calls.push("account");
        return account(["trader"]);
      },
      async selectWorkspace() {
        workspaceCalls += 1;
        throw new NyumaApiError(403, "workspace-not-assigned");
      },
      async submitRoleRequests() {
        throw new NyumaApiError(429, "rate-limited");
      },
      async listRoleRequests() {
        calls.push("requests");
        return [history("buyer", "pending")];
      },
      ...idleCoordination(),
    };
    const result = await chooseWorkspace(session.accessToken, "buyer", api);
    expect(result.error).toBe("workspace-not-assigned");
    expect(result.account.roles).toEqual(["trader"]);
    expect(screenForAccount(result.account)).toBe("choose-workspace");
    expect(workspaceCalls).toBe(1);
    await expect(sendRoleRequests(session.accessToken, ["farmer"], [], [], api)).rejects.toMatchObject({ code: "rate-limited" });
    expect(calls.filter((call) => call === "bootstrap")).toEqual([]);
  });

  it("keeps coordination and scenario storage untouched when an account session is rejected", () => {
    const store = memoryStore({
      [COORDINATION_STORAGE_KEY]: "coordination",
      [SCENARIO_STORAGE_KEY]: "scenario",
    });
    const principal = accountPrincipal(account(["farmer"], "farmer"), session.email);
    expect(principal && writeSession(store, principal)).toBe(false);
    expect(store.getItem("nyuma.session.v1")).toBeNull();
    expect(store.getItem(COORDINATION_STORAGE_KEY)).toBe("coordination");
    expect(store.getItem(SCENARIO_STORAGE_KEY)).toBe("scenario");
  });

  it("does not echo a token in an account message", () => {
    expect(accountMessage(session.accessToken)).toBe("Nyuma could not complete that request.");
    expect(accountMessage("rate-limited")).not.toContain(session.accessToken);
  });
});

function fakeApi(calls: string[], current: NyumaAccount, bootstrapStatus = 200): NyumaApi & { selectWorkspace: NyumaApi["selectWorkspace"] } {
  return {
    async bootstrap() {
      calls.push("bootstrap");
      if (bootstrapStatus === 401) throw new NyumaApiError(401, "unauthenticated");
      return current;
    },
    async account() {
      calls.push("account");
      return current;
    },
    async selectWorkspace() {
      calls.push("workspace");
      return current;
    },
    async submitRoleRequests() {
      calls.push("submit");
      return [];
    },
    async listRoleRequests() {
      calls.push("requests");
      return [];
    },
    ...idleCoordination(),
  };
}

function idleCoordination(): Pick<
  NyumaApi,
  | "createListing"
  | "listListings"
  | "getListing"
  | "updateListing"
  | "deleteListing"
  | "listMarketListings"
  | "createRequirement"
  | "listRequirements"
  | "getRequirement"
  | "updateRequirement"
  | "deleteRequirement"
  | "listMarketRequirements"
  | "createAgreement"
  | "listAgreements"
  | "getAgreement"
  | "updateAgreement"
  | "createPurchase"
  | "listPurchases"
  | "getPurchase"
  | "createOutcome"
  | "listOutcomes"
  | "getOutcome"
> {
  const unexpected = async () => {
    throw new Error("coordination was not part of this account-flow test");
  };
  return {
    createListing: unexpected,
    listListings: unexpected,
    getListing: unexpected,
    updateListing: unexpected,
    deleteListing: unexpected,
    listMarketListings: unexpected,
    createRequirement: unexpected,
    listRequirements: unexpected,
    getRequirement: unexpected,
    updateRequirement: unexpected,
    deleteRequirement: unexpected,
    listMarketRequirements: unexpected,
    createAgreement: unexpected,
    listAgreements: unexpected,
    getAgreement: unexpected,
    updateAgreement: unexpected,
    createPurchase: unexpected,
    listPurchases: unexpected,
    getPurchase: unexpected,
    createOutcome: unexpected,
    listOutcomes: unexpected,
    getOutcome: unexpected,
  };
}
