import { useState, type ReactNode } from "react";
import { navigationFor, notificationsHash, type WorkspaceSection } from "../lib/access";
import type { SessionUser } from "../lib/auth";
import { roleLabel } from "../lib/sampleUsers";
import { Logo } from "./Logo";

interface WorkspaceShellProps {
  user: SessionUser;
  section: WorkspaceSection;
  title: string;
  description: string;
  onSignOut: () => void;
  children: ReactNode;
}

export function WorkspaceShell({ user, section, title, description, onSignOut, children }: WorkspaceShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navigationFor(user.role);
  const firstName = user.name.split(" ")[0];

  return (
    <section className="dash" data-workspace={user.role} data-section={section.id}>
      <aside className={menuOpen ? "dash-side is-open" : "dash-side"}>
        <div className="side-bar">
          <a className="side-brand" href="#top">
            <Logo light />
            <strong>Nyuma</strong>
          </a>
          <button
            type="button"
            className="workspace-menu"
            aria-expanded={menuOpen}
            aria-controls="workspace-nav"
            onClick={() => setMenuOpen((current) => !current)}
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
        <nav id="workspace-nav" aria-label="Workspace">
          {items.map((item) => {
            const current = item.id === section.id;
            return (
              <a
                key={item.id}
                href={item.hash}
                aria-current={current ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="side-promo">
          {user.sample ? (
            <p>Sample {roleLabel(user.role).toLowerCase()} workspace. This sign-in is a demonstration.</p>
          ) : (
            <p>This workspace follows the role granted to your account.</p>
          )}
        </div>
      </aside>
      <div className="dash-main">
        <header className="dash-top">
          <div>
            <p className="eyebrow">{user.sample ? `Sample ${roleLabel(user.role)}` : roleLabel(user.role)}</p>
            <h2 id="workspace-title">
              {section.id === "trader-overview" ? `Welcome back, ${firstName}` : title}
            </h2>
            <p>{description}</p>
          </div>
          <div className="app-user">
            <a className="bell" href={notificationsHash(user.role)}>
              Notifications
              <span className="sr-only">No new notifications</span>
            </a>
            <p>
              <span className="avatar" aria-hidden="true">
                {user.name.slice(0, 1)}
              </span>
              <span>
                <strong>{user.name}</strong>
                <small>
                  {roleLabel(user.role)}
                  {user.sample ? " · sample account" : ""}
                </small>
              </span>
              {user.sample ? null : (
                <a href="#account">Switch workspace</a>
              )}
              <button type="button" className="logout" onClick={onSignOut}>
                Log out
              </button>
            </p>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
