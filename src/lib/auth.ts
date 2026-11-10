import {
  ROLES,
  SAMPLE_TRADER,
  findSampleUserByEmail,
  readSampleSession,
  sessionForAccount,
  type Role,
  type SampleSession,
} from "./sampleUsers";

export const SESSION_STORAGE_KEY = "nyuma.session.v1";

/** In-memory workspace for an account whose roles came from GET /me. This is never stored as authorization. */
export interface AccountWorkspaceSession {
  version: 1;
  id: string;
  name: string;
  email: string;
  role: Role;
  sample: false;
  grantedRoles: readonly Role[];
}

export type SessionUser = SampleSession | AccountWorkspaceSession;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The original sample trader. Other demonstration accounts live in SAMPLE_USERS. */
export const SAMPLE_ACCOUNT = SAMPLE_TRADER;

export type SignInResult = { ok: true; user: SampleSession } | { ok: false; message: string };

export function signIn(email: string, password: string): SignInResult {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) {
    return { ok: false, message: "Enter the email and password for this sample account." };
  }
  const account = findSampleUserByEmail(normalized);
  if (!account || password !== account.password) {
    return { ok: false, message: "That email and password do not match a sample account." };
  }
  return { ok: true, user: sessionForAccount(account) };
}

export function readSession(store: KeyValueStore): SampleSession | null {
  try {
    const raw = store.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return readSampleSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSession(store: KeyValueStore, user: SessionUser): boolean {
  const session = readSampleSession(user);
  if (!session) return false;
  store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return true;
}

export function clearSession(store: KeyValueStore): void {
  store.removeItem(SESSION_STORAGE_KEY);
}

/** Accept a sample session, or an in-memory account session whose role is one of its granted roles. */
export function readActor(value: unknown): SessionUser | null {
  const sample = readSampleSession(value);
  if (sample) return sample;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<AccountWorkspaceSession>;
  if (record.version !== 1 || record.sample !== false) return null;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 80 || /\s/.test(record.id)) return null;
  if (typeof record.email !== "string" || record.email.length > 320 || !record.email.includes("@") || /\s/.test(record.email)) {
    return null;
  }
  if (typeof record.name !== "string" || record.name.trim() === "" || record.name.length > 80) return null;
  if (typeof record.role !== "string" || !ROLES.includes(record.role as Role)) return null;
  if (!Array.isArray(record.grantedRoles)) return null;
  const grantedRoles = record.grantedRoles.filter((role): role is Role => typeof role === "string" && ROLES.includes(role as Role));
  if (grantedRoles.length !== record.grantedRoles.length || !grantedRoles.includes(record.role as Role)) return null;
  return {
    version: 1,
    id: record.id,
    name: record.name.trim(),
    email: record.email,
    role: record.role as Role,
    sample: false,
    grantedRoles,
  };
}
