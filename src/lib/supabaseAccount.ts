import { credentialsError, emailError, type AuthSession } from "./accountFlow";

export class AccountAuthError extends Error {
  readonly code: "rejected" | "not-configured" | "invalid";

  constructor(code: "rejected" | "not-configured" | "invalid") {
    super(code);
    this.name = "AccountAuthError";
    this.code = code;
  }
}

export interface RegistrationResult {
  confirmationRequired: boolean;
  session: AuthSession | null;
}

export interface SupabaseSessionLike {
  access_token?: string;
  user?: { email?: string | null } | null;
}

export interface SupabaseAuthLike {
  getSession(): Promise<{ data: { session: SupabaseSessionLike | null }; error: { message: string } | null }>;
  onAuthStateChange(
    callback: (event: string, session: SupabaseSessionLike | null) => void,
  ): { data: { subscription: { unsubscribe(): void } } };
  signUp(credentials: { email: string; password: string }): Promise<{
    data: { session: SupabaseSessionLike | null };
    error: { message: string } | null;
  }>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<{
    data: { session: SupabaseSessionLike | null };
    error: { message: string } | null;
  }>;
  signOut(): Promise<{ error: { message: string } | null }>;
  resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<{ error: { message: string } | null }>;
}

export interface AccountGateway {
  readonly configured: boolean;
  restore(): Promise<AuthSession | null>;
  subscribe(listener: (session: AuthSession | null) => void): () => void;
  register(email: string, password: string): Promise<RegistrationResult>;
  login(email: string, password: string): Promise<AuthSession>;
  logout(): Promise<void>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
}

const PLACEHOLDERS = ["your-project-ref", "your-anon-key", "change-me", "your-key", "replace-me"];

export function readPublishableConfig(input: { url?: string; anonKey?: string }): { url: string; anonKey: string } | null {
  const url = input.url?.trim() ?? "";
  const anonKey = input.anonKey?.trim() ?? "";
  if (!url || !anonKey) return null;
  const combined = `${url} ${anonKey}`.toLowerCase();
  if (PLACEHOLDERS.some((item) => combined.includes(item)) || combined.includes("service_role")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null;
  return { url: parsed.origin, anonKey };
}

export function createUnconfiguredGateway(): AccountGateway {
  return {
    configured: false,
    async restore() {
      return null;
    },
    subscribe() {
      return () => undefined;
    },
    async register() {
      throw new AccountAuthError("not-configured");
    },
    async login() {
      throw new AccountAuthError("not-configured");
    },
    async logout() {
      return;
    },
    async requestPasswordReset() {
      throw new AccountAuthError("not-configured");
    },
  };
}

export function createSupabaseGateway(auth: SupabaseAuthLike): AccountGateway {
  return {
    configured: true,
    async restore() {
      const result = await auth.getSession();
      if (result.error) return null;
      return sessionFrom(result.data.session);
    },
    subscribe(listener) {
      const subscription = auth.onAuthStateChange((_event, session) => {
        listener(sessionFrom(session));
      });
      return () => subscription.data.subscription.unsubscribe();
    },
    async register(email, password) {
      if (credentialsError(email, password)) throw new AccountAuthError("invalid");
      const result = await auth.signUp({ email: email.trim(), password });
      if (result.error) throw new AccountAuthError("rejected");
      const session = sessionFrom(result.data.session);
      return { confirmationRequired: !session, session };
    },
    async login(email, password) {
      if (credentialsError(email, password)) throw new AccountAuthError("invalid");
      const result = await auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw new AccountAuthError("rejected");
      const session = sessionFrom(result.data.session);
      if (!session) throw new AccountAuthError("rejected");
      return session;
    },
    async logout() {
      const result = await auth.signOut();
      if (result.error) throw new AccountAuthError("rejected");
    },
    async requestPasswordReset(email, redirectTo) {
      if (emailError(email)) throw new AccountAuthError("invalid");
      const result = await auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (result.error) throw new AccountAuthError("rejected");
    },
  };
}

/** Holds the signed-in screen while the browser loads the Supabase client. */
export function createPendingGateway(): AccountGateway {
  return {
    configured: true,
    restore: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    async register() {
      throw new AccountAuthError("not-configured");
    },
    async login() {
      throw new AccountAuthError("not-configured");
    },
    async logout() {
      return;
    },
    async requestPasswordReset() {
      throw new AccountAuthError("not-configured");
    },
  };
}

export async function loadConfiguredGateway(
  env: { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string } = import.meta.env,
): Promise<AccountGateway> {
  const config = readPublishableConfig({ url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY });
  if (!config) return createUnconfiguredGateway();
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return createSupabaseGateway(client.auth as SupabaseAuthLike);
}

function sessionFrom(session: SupabaseSessionLike | null): AuthSession | null {
  const email = session?.user?.email?.trim() ?? "";
  const accessToken = session?.access_token ?? "";
  if (!email || !accessToken) return null;
  return { accessToken, email };
}
