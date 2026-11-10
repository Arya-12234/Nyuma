import { useState, type FormEvent } from "react";
import { signIn, type SessionUser } from "../lib/auth";
import { roleLabel, SAMPLE_USERS } from "../lib/sampleUsers";
import { Logo } from "./Logo";

interface LoginScreenProps {
  onSuccess: (user: SessionUser) => void;
}

export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = signIn(email, password);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess(result.user);
  }

  return (
    <main className="login">
      <section className="login-card" aria-labelledby="login-title">
        <a className="brand" href="#top">
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <h1 id="login-title">Sign in to the workspace</h1>
        <p>
          Demonstration only. This is not production sign-in. These sample accounts are not real customers, and
          nothing is sent to a server.
        </p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : "sample-accounts"}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </div>
          {error ? (
            <p className="field-error" id="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn btn-lime login-submit" type="submit">
            Sign in
          </button>
        </form>
        <p className="login-links">
          <a href="#sign-in">Sign in with your account</a>
          <a href="#register">Create an account</a>
        </p>
        <ul className="login-sample" id="sample-accounts" aria-label="Sample accounts">
          {SAMPLE_USERS.map((account) => (
            <li key={account.id}>
              Sample {roleLabel(account.role)}: {account.email} · {account.password}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
