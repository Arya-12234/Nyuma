import { useState, type FormEvent } from "react";
import { accountMessage } from "../lib/accountFlow";
import { AccountAuthError } from "../lib/supabaseAccount";
import { Logo } from "./Logo";

export type AccountMode = "register" | "sign-in" | "reset";

interface AccountAccessProps {
  mode: AccountMode;
  configured: boolean;
  notice: string | null;
  busy: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<"confirmation" | "signed-in">;
  onReset: (email: string) => Promise<void>;
}

export function AccountAccess({ mode, configured, notice, busy, onLogin, onRegister, onReset }: AccountAccessProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    if (!configured) {
      setError(accountMessage("not-configured"));
      return;
    }
    try {
      if (mode === "reset") {
        await onReset(email);
        setError(null);
        setDone("If the address can receive mail, a reset link will be sent.");
        return;
      }
      if (mode === "register") {
        const result = await onRegister(email, password);
        if (result === "confirmation") {
          setError(null);
          setDone("Check your email to confirm the account before signing in.");
        }
        return;
      }
      await onLogin(email, password);
      setError(null);
    } catch (caught) {
      const code = caught instanceof AccountAuthError ? caught.code : "rejected";
      setDone(null);
      setError(accountMessage(code));
    }
  }

  const title = mode === "register" ? "Create an account" : mode === "reset" ? "Reset your password" : "Sign in";
  const copy =
    mode === "register"
      ? "Create an account with your email. This does not grant a farmer, trader, or buyer role."
      : mode === "reset"
        ? "Ask for a password reset link. This page cannot confirm whether an account exists."
        : "Sign in with the account you created. A sample workspace is separate and does not use this password.";

  return (
    <main className="login">
      <section className="login-card account-card" aria-labelledby="account-title">
        <a className="brand" href="#top">
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <h1 id="account-title">{title}</h1>
        <p>{copy}</p>
        {configured ? null : (
          <p className="account-note" role="status">
            Account sign-in is not configured. Add the documented environment variables. No account was created.
          </p>
        )}
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="account-email">Email</label>
            <input
              id="account-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
            />
          </div>
          {mode === "reset" ? null : (
            <div className="field">
              <label htmlFor="account-password">Password</label>
              <input
                id="account-password"
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
            </div>
          )}
          {error ? (
            <p className="field-error" id="account-error" role="alert">
              {error}
            </p>
          ) : null}
          {done ? (
            <p className="account-note" role="status">
              {done}
            </p>
          ) : null}
          {notice ? (
            <p className="field-error" role="alert">
              {notice}
            </p>
          ) : null}
          <button className="btn btn-lime login-submit" type="submit" disabled={busy}>
            {mode === "register" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}
          </button>
        </form>
        <p className="login-links">
          {mode === "sign-in" ? null : <a href="#sign-in">Sign in</a>}
          {mode === "register" ? null : <a href="#register">Create account</a>}
          {mode === "reset" ? null : <a href="#reset">Reset password</a>}
          <a href="#login">Sample workspace</a>
        </p>
      </section>
    </main>
  );
}
