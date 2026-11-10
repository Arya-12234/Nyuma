import { describe, expect, it } from "vitest";
import { AccountAuthError, createSupabaseGateway, createUnconfiguredGateway, loadConfiguredGateway, readPublishableConfig, type SupabaseAuthLike, type SupabaseSessionLike } from "./supabaseAccount";

const password = "secret-password";

function session(email = "ada@example.com"): SupabaseSessionLike {
  return { access_token: "access-token-for-tests", user: { email } };
}

function auth(partial: Partial<SupabaseAuthLike> = {}): SupabaseAuthLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSession() {
      calls.push("session");
      return { data: { session: session() }, error: null };
    },
    onAuthStateChange() {
      calls.push("subscribe");
      return { data: { subscription: { unsubscribe() { calls.push("unsubscribe"); } } } };
    },
    async signUp() {
      calls.push("register");
      return { data: { session: session() }, error: null };
    },
    async signInWithPassword() {
      calls.push("login");
      return { data: { session: session() }, error: null };
    },
    async signOut() {
      calls.push("logout");
      return { error: null };
    },
    async resetPasswordForEmail() {
      calls.push("reset");
      return { error: null };
    },
    ...partial,
  };
}

describe("Supabase account gateway", () => {
  it("accepts only a real https project and a publishable key", () => {
    expect(readPublishableConfig({ url: "https://example.supabase.co", anonKey: "publishable-key" })).toEqual({
      url: "https://example.supabase.co",
      anonKey: "publishable-key",
    });
    expect(readPublishableConfig({})).toBeNull();
    expect(readPublishableConfig({ url: "https://your-project-ref.supabase.co", anonKey: "your-anon-key" })).toBeNull();
    expect(readPublishableConfig({ url: "http://example.supabase.co", anonKey: "publishable-key" })).toBeNull();
    expect(readPublishableConfig({ url: "https://user:secret@example.supabase.co", anonKey: "publishable-key" })).toBeNull();
    expect(readPublishableConfig({ url: "https://example.supabase.co", anonKey: "service_role-secret" })).toBeNull();
  });

  it("registers, signs in, restores, resets, and signs out through the client", async () => {
    const client = auth();
    const gateway = createSupabaseGateway(client);
    await expect(gateway.register("ada@example.com", password)).resolves.toMatchObject({
      confirmationRequired: false,
      session: { email: "ada@example.com", accessToken: "access-token-for-tests" },
    });
    await expect(gateway.login("ada@example.com", password)).resolves.toMatchObject({ email: "ada@example.com" });
    await expect(gateway.restore()).resolves.toMatchObject({ email: "ada@example.com" });
    await gateway.requestPasswordReset("ada@example.com", "http://127.0.0.1:5173/#sign-in");
    await gateway.logout();
    expect(client.calls).toEqual(["register", "login", "session", "reset", "logout"]);
  });

  it("reports rejected registration and login without the password", async () => {
    const client = auth({
      async signUp() {
        return { data: { session: null }, error: { message: `rejected ${password}` } };
      },
      async signInWithPassword() {
        return { data: { session: null }, error: { message: `rejected ${password}` } };
      },
    });
    const gateway = createSupabaseGateway(client);
    const registration = await gateway.register("ada@example.com", password).then(
      () => null,
      (error: unknown) => error,
    );
    const login = await gateway.login("ada@example.com", password).then(
      () => null,
      (error: unknown) => error,
    );
    expect(registration).toBeInstanceOf(AccountAuthError);
    expect(login).toBeInstanceOf(AccountAuthError);
    expect(String(registration)).not.toContain(password);
    expect(String(login)).not.toContain(password);
  });

  it("asks for confirmation when registration has no session", async () => {
    const gateway = createSupabaseGateway(auth({
      async signUp() {
        return { data: { session: null }, error: null };
      },
    }));
    await expect(gateway.register("ada@example.com", password)).resolves.toEqual({
      confirmationRequired: true,
      session: null,
    });
  });

  it("does not call the client for an invalid email or an unconfigured project", async () => {
    const client = auth();
    const gateway = createSupabaseGateway(client);
    await expect(gateway.login("not-an-email", password)).rejects.toMatchObject({ code: "invalid" });
    await expect(gateway.requestPasswordReset("not-an-email", "http://127.0.0.1:5173/#sign-in")).rejects.toMatchObject({
      code: "invalid",
    });
    expect(client.calls).toEqual([]);
    await expect(createUnconfiguredGateway().register("ada@example.com", password)).rejects.toMatchObject({
      code: "not-configured",
    });
    await expect(createUnconfiguredGateway().requestPasswordReset("ada@example.com", "http://127.0.0.1:5173/#sign-in")).rejects.toMatchObject({
      code: "not-configured",
    });
  });

  it("does not load a client when the project is not configured", async () => {
    await expect(loadConfiguredGateway({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" })).resolves.toMatchObject({
      configured: false,
    });
  });

  it("treats a failed session lookup as signed out", async () => {
    const gateway = createSupabaseGateway(auth({
      async getSession() {
        return { data: { session: null }, error: { message: "expired access-token-for-tests" } };
      },
    }));
    await expect(gateway.restore()).resolves.toBeNull();
  });
});
