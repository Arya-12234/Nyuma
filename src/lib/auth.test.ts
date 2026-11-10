import { describe, expect, it } from "vitest";
import {
  SAMPLE_ACCOUNT,
  SESSION_STORAGE_KEY,
  clearSession,
  readSession,
  signIn,
  writeSession,
  type KeyValueStore,
  type SessionUser,
} from "./auth";
import { SAMPLE_USERS } from "./sampleUsers";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("signIn", () => {
  it("accepts the sample account, including a differently cased email", () => {
    const result = signIn("  Winnie@Nyuma.ke ", SAMPLE_ACCOUNT.password);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.name).toBe("Winnie Mutheu");
      expect(result.user.email).toBe(SAMPLE_ACCOUNT.email);
    }
  });

  it("rejects a wrong password", () => {
    const result = signIn(SAMPLE_ACCOUNT.email, "wrong-password");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty form", () => {
    expect(signIn("", "").ok).toBe(false);
    expect(signIn("   ", "harvest40").ok).toBe(false);
  });

  it("signs in each sample role and keeps the trader account compatible", () => {
    expect(SAMPLE_USERS.map((account) => account.role)).toEqual(["farmer", "trader", "buyer", "administrator"]);
    for (const account of SAMPLE_USERS) {
      const result = signIn(account.email.toUpperCase(), account.password);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user).toEqual({
        version: 1,
        id: account.id,
        name: account.name,
        email: account.email,
        role: account.role,
        sample: true,
      });
      expect(result.user).not.toHaveProperty("password");
    }
    const trader = signIn("winnie@nyuma.ke", "harvest40");
    expect(trader.ok && trader.user.role).toBe("trader");
    expect(trader.ok && trader.user.name).toBe("Winnie Mutheu");
  });
});

describe("session storage", () => {
  it("round-trips a signed-in user and clears it", () => {
    const store = memoryStore();
    const signedIn = signIn(SAMPLE_ACCOUNT.email, SAMPLE_ACCOUNT.password);
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;
    writeSession(store, signedIn.user);
    expect(readSession(store)?.name).toBe("Winnie Mutheu");
    clearSession(store);
    expect(store.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(readSession(store)).toBeNull();
    expect(JSON.stringify(signedIn.user)).not.toContain(SAMPLE_ACCOUNT.password);
  });

  it("logs out by removing the sample session", () => {
    const store = memoryStore();
    const signedIn = signIn(SAMPLE_ACCOUNT.email, SAMPLE_ACCOUNT.password);
    if (!signedIn.ok) throw new Error("sample trader was rejected");
    expect(writeSession(store, signedIn.user)).toBe(true);
    clearSession(store);
    expect(readSession(store)).toBeNull();
  });

  it("rejects a corrupt, unknown, or forged session", () => {
    expect(readSession(memoryStore({ [SESSION_STORAGE_KEY]: "{" }))).toBeNull();
    expect(readSession(memoryStore({ [SESSION_STORAGE_KEY]: JSON.stringify({ version: 2 }) }))).toBeNull();
    expect(
      readSession(
        memoryStore({
          [SESSION_STORAGE_KEY]: JSON.stringify({ version: 1, name: "Other", email: "other@nyuma.ke", role: "Trader" }),
        }),
      ),
    ).toBeNull();

    const forgedRole: SessionUser = {
      version: 1,
      id: "sample-trader",
      name: "Winnie Mutheu",
      email: "winnie@nyuma.ke",
      role: "administrator",
      sample: true,
    };
    const store = memoryStore();
    expect(writeSession(store, forgedRole)).toBe(false);
    expect(store.getItem(SESSION_STORAGE_KEY)).toBeNull();
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(forgedRole));
    expect(readSession(store)).toBeNull();
  });
});
