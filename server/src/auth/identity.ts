import pg from "pg";
import type { ClientBase } from "pg";
import { currentRequestToken, withPooledSession } from "../db/session.js";
import { runTransaction } from "../db/transaction.js";

export const workspaceRoles = ["farmer", "trader", "buyer", "administrator"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export type AccountStatus = "active" | "suspended" | "deactivated";

export interface AccountView {
  id: string;
  status: AccountStatus;
  roles: WorkspaceRole[];
  activeRole: WorkspaceRole | null;
}

export class AccountNotBootstrapped extends Error {
  constructor() {
    super("account-not-bootstrapped");
  }
}

export class AccountDisabled extends Error {
  constructor() {
    super("account-disabled");
  }
}

export class WorkspaceNotAssigned extends Error {
  constructor() {
    super("workspace-not-assigned");
  }
}

export class InvalidRequest extends Error {
  constructor() {
    super("invalid-request");
  }
}

export const ordinaryRoles = ["farmer", "trader", "buyer"] as const;
export type OrdinaryRole = (typeof ordinaryRoles)[number];

export interface RoleRequestSubmission {
  id: string | null;
  role: OrdinaryRole;
  status: "pending" | "granted";
  requestedAt: string | null;
  decidedAt: string | null;
}

export interface RoleRequestHistory {
  id: string;
  role: OrdinaryRole;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  granted: boolean;
}

export interface IdentityStore {
  bootstrap(authUserId: string): Promise<AccountView>;
  findAccount(authUserId: string): Promise<AccountView | null>;
  setActiveRole(authUserId: string, role: string): Promise<AccountView>;
  submitRoleRequests(authUserId: string, roles: string[]): Promise<RoleRequestSubmission[]>;
  listRoleRequests(authUserId: string): Promise<RoleRequestHistory[]>;
  close(): Promise<void>;
}

export function createPostgresIdentityStore(databaseUrl: string): IdentityStore {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
  return {
    bootstrap(authUserId) {
      return withClient(pool, (client) =>
        runTransaction(client, async (tx) => {
          await tx.query(
            "INSERT INTO users (auth_user_id) VALUES ($1) ON CONFLICT (auth_user_id) DO NOTHING",
            [authUserId],
          );
          const account = await readAccount(tx, authUserId);
          if (!account) throw new AccountNotBootstrapped();
          if (account.status !== "active") throw new AccountDisabled();
          return account;
        }),
      );
    },
    findAccount(authUserId) {
      return withClient(pool, async (client) => readAccount(client, authUserId));
    },
    setActiveRole(authUserId, role) {
      return withClient(pool, async (client) => {
        const current = await readAccount(client, authUserId);
        if (!current) throw new AccountNotBootstrapped();
        if (current.status !== "active") throw new AccountDisabled();
        if (!workspaceRoles.includes(role as WorkspaceRole) || !current.roles.includes(role as WorkspaceRole)) {
          throw new WorkspaceNotAssigned();
        }
        try {
          await client.query("SELECT nyuma_set_active_role($1, $2)", [current.id, role]);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "P0001") throw new WorkspaceNotAssigned();
          throw error;
        }
        const updated = await readAccount(client, authUserId);
        if (!updated) throw new AccountNotBootstrapped();
        return updated;
      });
    },
    submitRoleRequests(authUserId, roles) {
      return withClient(pool, async (client) => {
        try {
          const result = await client.query<{
            id: string | null;
            role: string;
            status: string;
            requested_at: Date | string | null;
            decided_at: Date | string | null;
          }>("SELECT id, role, status, requested_at, decided_at FROM nyuma_submit_role_requests($1, $2::text[])", [
            authUserId,
            roles,
          ]);
          return result.rows.map((row) => ({
            id: row.id,
            role: ordinaryRole(row.role),
            status: row.status === "granted" ? "granted" : "pending",
            requestedAt: iso(row.requested_at),
            decidedAt: iso(row.decided_at),
          }));
        } catch (error) {
          raiseMapped(error);
        }
      });
    },
    listRoleRequests(authUserId) {
      return withClient(pool, async (client) => {
        try {
          const result = await client.query<{
            id: string;
            role: string;
            status: string;
            requested_at: Date | string;
            decided_at: Date | string | null;
            decision_note: string | null;
            granted: boolean;
          }>(
            `SELECT id, role, status, requested_at, decided_at, decision_note, granted
             FROM nyuma_list_role_requests($1)`,
            [authUserId],
          );
          return result.rows.map((row) => ({
            id: row.id,
            role: ordinaryRole(row.role),
            status: historyStatus(row.status),
            requestedAt: iso(row.requested_at) ?? "",
            decidedAt: iso(row.decided_at),
            decisionNote: row.decision_note,
            granted: row.granted,
          }));
        } catch (error) {
          raiseMapped(error);
        }
      });
    },
    async close() {
      await pool.end();
    },
  };
}

function withClient<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withPooledSession(pool, currentRequestToken(), work);
}

function raiseMapped(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error) {
    const message = String(error.message);
    if (message.includes("account-not-bootstrapped")) throw new AccountNotBootstrapped();
    if (message.includes("account-disabled")) throw new AccountDisabled();
    if (message.includes("invalid-request")) throw new InvalidRequest();
  }
  throw error;
}

function ordinaryRole(role: string): OrdinaryRole {
  if (role === "farmer" || role === "trader" || role === "buyer") return role;
  throw new InvalidRequest();
}

function historyStatus(status: string): RoleRequestHistory["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") return status;
  throw new InvalidRequest();
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function readAccount(client: ClientBase, authUserId: string): Promise<AccountView | null> {
  const result = await client.query<{ id: string; status: AccountStatus; active_role: WorkspaceRole | null; roles: string[] | null }>(
    `SELECT u.id, u.status, u.active_role,
            (SELECT array_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id) AS roles
     FROM users u
     WHERE u.auth_user_id = $1`,
    [authUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    roles: (row.roles ?? []).filter((role): role is WorkspaceRole => workspaceRoles.includes(role as WorkspaceRole)),
    activeRole: row.active_role,
  };
}
