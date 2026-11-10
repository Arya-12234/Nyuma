import { createClient } from "@supabase/supabase-js";

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export type RegistrationResult = AuthSession | { confirmationRequired: true };

export interface AuthGateway {
  register(email: string, password: string): Promise<RegistrationResult>;
  login(email: string, password: string): Promise<AuthSession>;
  logout(accessToken: string): Promise<void>;
  refresh(refreshToken: string): Promise<AuthSession>;
}

export class AuthRejected extends Error {
  constructor() {
    super("auth-rejected");
  }
}

/**
 * Talks to Supabase Auth with the anon key. The service-role key is never read.
 * Passwords and tokens are not written to the error text.
 */
export function createSupabaseAuthGateway(supabaseUrl: string, anonKey: string): AuthGateway {
  function client() {
    return createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return {
    async register(email, password) {
      const { data, error } = await client().auth.signUp({ email, password });
      if (error) throw new AuthRejected();
      if (!data.session) return { confirmationRequired: true };
      return sessionFrom(data.session.access_token, data.session.refresh_token, data.session.expires_at);
    },
    async login(email, password) {
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      if (error || !data.session) throw new AuthRejected();
      return sessionFrom(data.session.access_token, data.session.refresh_token, data.session.expires_at);
    },
    async logout(accessToken) {
      const response = await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok && response.status !== 204) throw new AuthRejected();
    },
    async refresh(refreshToken) {
      const { data, error } = await client().auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session) throw new AuthRejected();
      return sessionFrom(data.session.access_token, data.session.refresh_token, data.session.expires_at);
    },
  };
}

function sessionFrom(accessToken: string, refreshToken: string, expiresAt: number | undefined): AuthSession {
  return { accessToken, refreshToken, expiresAt: expiresAt ?? null };
}
