import type { SessionUser } from "./auth";
import {
  NyumaApiError,
  type NyumaAccount,
  type NyumaApi,
  type OrdinaryRole,
  type RoleRequestHistory,
  type RoleRequestSubmission,
} from "./nyumaApi";
import type { Role } from "./sampleUsers";

export const ORDINARY_ROLES = ["farmer", "trader", "buyer"] as const;

export interface LoadedAccount {
  account: NyumaAccount;
  requests: RoleRequestHistory[];
}

export interface AuthSession {
  accessToken: string;
  email: string;
}

export type AccountScreen = "disabled" | "onboarding" | "choose-workspace" | "workspace";

const MESSAGES: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  "account-disabled": "This account is not active.",
  "workspace-not-assigned": "That role is not granted to this account.",
  "rate-limited": "Please wait before sending another role request.",
  "invalid-request": "That request was not accepted.",
  "account-not-bootstrapped": "The account is not ready yet.",
  "not-configured": "Account sign-in is not configured. Add the documented environment variables. No account was created.",
  rejected: "Those details were not accepted.",
  invalid: "Enter an email address and a password.",
  "request-failed": "Nyuma could not complete that request.",
  "not-found": "That record could not be found.",
  "role-not-granted": "This account does not have the role required for that record.",
  conflict: "That change was not saved.",
  relationship: "That record is still linked to another record, so it was not removed.",
};

export function accountMessage(code: string): string {
  return MESSAGES[code] ?? MESSAGES["request-failed"];
}

export function credentialsError(email: string, password: string): "invalid" | null {
  if (emailError(email) || !password || password.length > 1024) return "invalid";
  return null;
}

export function emailError(email: string): "invalid" | null {
  const normalized = email.trim();
  if (!normalized || normalized.length > 320 || !normalized.includes("@") || /\s/.test(normalized)) return "invalid";
  return null;
}

/** Granted roles come only from the account. Pending requests are not an input. */
export function screenForAccount(account: NyumaAccount): AccountScreen {
  if (account.status !== "active") return "disabled";
  if (account.roles.length === 0) return "onboarding";
  if (!account.activeRole || !account.roles.includes(account.activeRole)) return "choose-workspace";
  return "workspace";
}

export function workspaceRevoked(account: NyumaAccount): boolean {
  return account.activeRole !== null && !account.roles.includes(account.activeRole);
}

export type RoleChoice = "granted" | "pending" | "rejected" | "open";

export function roleRequestState(
  role: OrdinaryRole,
  requests: readonly RoleRequestHistory[],
  grantedRoles: readonly string[],
): RoleChoice {
  if (grantedRoles.includes(role)) return "granted";
  if (requests.some((item) => item.role === role && item.status === "pending")) return "pending";
  if (requests.some((item) => item.role === role && item.status === "rejected")) return "rejected";
  return "open";
}

export function rolesForSubmission(
  selected: readonly string[],
  requests: readonly RoleRequestHistory[],
  grantedRoles: readonly string[],
): OrdinaryRole[] {
  return ORDINARY_ROLES.filter((role) => {
    if (!selected.includes(role)) return false;
    const state = roleRequestState(role, requests, grantedRoles);
    return state === "open" || state === "rejected";
  });
}

export function submissionNotice(submissions: readonly RoleRequestSubmission[]): string {
  if (submissions.some((item) => item.status === "granted")) {
    return "A requested role is already granted. Only a granted role can open a workspace.";
  }
  return "The role request was sent. A request does not open a workspace.";
}

export function accountPrincipal(account: NyumaAccount, email: string): SessionUser | null {
  if (account.status !== "active" || !account.activeRole || !account.roles.includes(account.activeRole)) return null;
  const local = email.split("@")[0]?.trim() ?? "";
  return {
    version: 1,
    id: account.id,
    name: local.slice(0, 40) || "Account",
    email,
    role: account.activeRole,
    sample: false,
    grantedRoles: [...account.roles],
  };
}

export function holdSubmission(lock: { held: boolean }): boolean {
  if (lock.held) return false;
  lock.held = true;
  return true;
}

export function releaseSubmission(lock: { held: boolean }): void {
  lock.held = false;
}

export function createSessionGate() {
  let token: string | null = null;
  let email: string | null = null;
  return {
    claim(session: AuthSession | null): "signed-out" | "skip" | "refresh" | "load" {
      if (!session) {
        token = null;
        email = null;
        return "signed-out";
      }
      if (email === session.email && token === session.accessToken) return "skip";
      if (email === session.email) {
        token = session.accessToken;
        return "refresh";
      }
      email = session.email;
      token = session.accessToken;
      return "load";
    },
    release() {
      token = null;
      email = null;
    },
  };
}

export async function openSession(token: string, api: NyumaApi): Promise<LoadedAccount> {
  await api.bootstrap(token);
  return refreshAccount(token, api);
}

export async function refreshAccount(token: string, api: NyumaApi): Promise<LoadedAccount> {
  const account = await api.account(token);
  const requests = await api.listRoleRequests(token);
  return { account, requests };
}

export async function chooseWorkspace(
  token: string,
  role: string,
  api: NyumaApi,
): Promise<LoadedAccount & { error: string | null }> {
  try {
    await api.selectWorkspace(token, role);
  } catch (error) {
    const code = error instanceof NyumaApiError ? error.code : "request-failed";
    if (code !== "workspace-not-assigned") throw error;
    return { ...(await refreshAccount(token, api)), error: code };
  }
  return { ...(await refreshAccount(token, api)), error: null };
}

export async function sendRoleRequests(
  token: string,
  roles: readonly string[],
  requests: readonly RoleRequestHistory[],
  grantedRoles: readonly string[],
  api: NyumaApi,
): Promise<LoadedAccount & { submissions: RoleRequestSubmission[] }> {
  const accepted = rolesForSubmission(roles, requests, grantedRoles);
  if (accepted.length === 0) throw new NyumaApiError(400, "invalid-request");
  const submissions = await api.submitRoleRequests(token, accepted);
  return { submissions, ...(await refreshAccount(token, api)) };
}

export async function restoreThenLoad(
  restore: () => Promise<AuthSession | null>,
  api: NyumaApi,
): Promise<{ phase: "signed-out" | AccountScreen | "error"; failure: string | null; loaded: LoadedAccount | null }> {
  const session = await restore();
  if (!session) return { phase: "signed-out", failure: null, loaded: null };
  try {
    const loaded = await openSession(session.accessToken, api);
    return { phase: screenForAccount(loaded.account), failure: null, loaded };
  } catch (error) {
    const code = error instanceof NyumaApiError ? error.code : "request-failed";
    if (code === "unauthenticated") return { phase: "signed-out", failure: code, loaded: null };
    if (code === "account-disabled") return { phase: "disabled", failure: code, loaded: null };
    return { phase: "error", failure: code, loaded: null };
  }
}

export function roleLabelFor(role: Role | OrdinaryRole): string {
  if (role === "farmer") return "Farmer";
  if (role === "trader") return "Trader";
  if (role === "buyer") return "Buyer";
  return "Administrator";
}
