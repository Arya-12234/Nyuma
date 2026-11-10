import { roleLabel } from "../lib/sampleUsers";
import type { SessionUser } from "../lib/auth";
import { Logo } from "./Logo";

export function AccessDenied({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  return (
    <main className="login">
      <section className="login-card" aria-labelledby="access-title">
        <a className="brand" href="#top">
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <h1 id="access-title">{user.sample ? "This sample role cannot open this page" : "This role cannot open this page"}</h1>
        <p>
          {user.sample
            ? `${user.name} is signed in as a sample ${roleLabel(user.role).toLowerCase()}. This page is not open to that role. The check is part of the demonstration, not production access control.`
            : `${user.name} is signed in as a ${roleLabel(user.role).toLowerCase()}. This page is not open to that role.`}
        </p>
        <div className="login-actions">
          <a className="btn btn-secondary" href="#workspace">
            Return to your workspace
          </a>
          <button type="button" className="btn btn-lime" onClick={onSignOut}>
            Log out
          </button>
        </div>
      </section>
    </main>
  );
}
