/**
 * Demonstration accounts only. These are not customers, and the passwords exist
 * so the local sample sign-in can be tried. They are never written into the session.
 */

export const ROLES = ["farmer", "trader", "buyer", "administrator"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  farmer: "Farmer",
  trader: "Trader",
  buyer: "Buyer",
  administrator: "Administrator",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

export interface SampleAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  sample: true;
}

export interface SampleSession {
  version: 1;
  id: string;
  name: string;
  email: string;
  role: Role;
  sample: true;
}

export const SAMPLE_USERS: readonly SampleAccount[] = [
  {
    id: "sample-farmer",
    name: "Sample Farmer",
    email: "farmer@nyuma.ke",
    password: "sample-farmer",
    role: "farmer",
    sample: true,
  },
  {
    id: "sample-trader",
    name: "Winnie Mutheu",
    email: "winnie@nyuma.ke",
    password: "harvest40",
    role: "trader",
    sample: true,
  },
  {
    id: "sample-buyer",
    name: "Sample Buyer",
    email: "buyer@nyuma.ke",
    password: "sample-buyer",
    role: "buyer",
    sample: true,
  },
  {
    id: "sample-administrator",
    name: "Sample Administrator",
    email: "admin@nyuma.ke",
    password: "sample-admin",
    role: "administrator",
    sample: true,
  },
];

export const SAMPLE_TRADER = SAMPLE_USERS.find((account) => account.email === "winnie@nyuma.ke") as SampleAccount;

export function findSampleUserByEmail(email: string): SampleAccount | null {
  const normalized = email.trim().toLowerCase();
  return SAMPLE_USERS.find((account) => account.email === normalized) ?? null;
}

export function sessionForAccount(account: SampleAccount): SampleSession {
  return {
    version: 1,
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    sample: true,
  };
}

/** Accept a session only when every identity field matches the sample account. A different role is rejected. */
export function readSampleSession(value: unknown): SampleSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.sample !== true) return null;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  if (typeof record.email !== "string" || typeof record.role !== "string") return null;

  const account = SAMPLE_USERS.find((item) => item.id === record.id);
  if (!account) return null;
  if (record.email !== account.email || record.name !== account.name || record.role !== account.role) return null;
  return sessionForAccount(account);
}
