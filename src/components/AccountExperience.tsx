import { useState, type ReactNode } from "react";
import { isWorkspaceHash } from "../lib/access";
import {
  ORDINARY_ROLES,
  accountPrincipal,
  roleLabelFor,
  roleRequestState,
  workspaceRevoked,
  type RoleChoice,
} from "../lib/accountFlow";
import type { NyumaAccount, NyumaApi, OrdinaryRole, RoleRequestHistory } from "../lib/nyumaApi";
import type { AccountUiState } from "../lib/useAccountSession";
import { RoleWorkspace } from "./RoleWorkspace";
import { Logo } from "./Logo";

interface AccountExperienceProps {
  state: AccountUiState;
  hash: string;
  busy: boolean;
  onSubmitRoles: (roles: string[]) => Promise<void>;
  onSelectRole: (role: string) => Promise<void>;
  onSignOut: () => void;
  onRetry: () => void;
  api?: NyumaApi | null;
  onExpire?: () => void;
  onSuspend?: () => void;
  onReconcile?: () => void;
}

const ROLE_COPY: Record<OrdinaryRole, string> = {
  farmer: "Record the produce you expect to sell.",
  trader: "Coordinate supply between farmers and buyers.",
  buyer: "Describe the produce you want to purchase.",
};

export function AccountExperience({
  state,
  hash,
  busy,
  onSubmitRoles,
  onSelectRole,
  onSignOut,
  onRetry,
  api = null,
  onExpire,
  onSuspend,
  onReconcile,
}: AccountExperienceProps) {
  if (state.phase === "restoring") {
    return <StatusCard title="Checking your session" body="Nyuma is restoring your sign-in." />;
  }
  if (state.phase === "disabled") {
    return (
      <StatusCard
        title="This account is not active"
        body="Nyuma cannot open a workspace for this account."
        action="Sign out"
        onAction={onSignOut}
      />
    );
  }
  if (state.phase === "error") {
    return (
      <StatusCard title="Nyuma could not open your account" body={state.message} action="Try again" onAction={onRetry}>
        <button type="button" className="btn btn-secondary" onClick={onSignOut}>
          Sign out
        </button>
      </StatusCard>
    );
  }
  if (state.phase !== "onboarding" && state.phase !== "choose-workspace" && state.phase !== "workspace") {
    return null;
  }
  if (state.phase === "workspace" && hash !== "#account") {
    const principal = accountPrincipal(state.account, state.session.email);
    if (principal) {
      const workspaceHash = isWorkspaceHash(hash) ? hash : "#workspace";
      return (
        <RoleWorkspace
          key={principal.id}
          user={principal}
          hash={workspaceHash}
          onSignOut={onSignOut}
          accessToken={state.session.accessToken}
          api={api}
          onUnauthenticated={onExpire}
          onAccountDisabled={onSuspend}
          onAccessDenied={onReconcile}
        />
      );
    }
  }

  return (
    <main className="login">
      <section className="login-card account-card" aria-labelledby="account-home-title" data-screen={state.phase}>
        <a className="brand" href="#top">
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <h1 id="account-home-title">{state.phase === "onboarding" ? "Request a role" : "Choose a workspace"}</h1>
        <p>Signed in as {state.session.email}.</p>
        {state.notice ? (
          <p className="account-note" role="status">
            {state.notice}
          </p>
        ) : null}
        {state.phase === "onboarding" ? (
          <p>A request waits for an operator. It does not open a workspace.</p>
        ) : (
          <p>Only a role already granted to this account can be selected.</p>
        )}
        {workspaceRevoked(state.account) ? (
          <p className="field-error" role="alert">
            That workspace is no longer available.
          </p>
        ) : null}
        {state.phase === "onboarding" ? null : (
          <div className="account-actions">
            {state.account.roles.map((role) => (
              <button
                key={role}
                type="button"
                className="btn btn-lime"
                data-granted={role}
                disabled={busy}
                onClick={() => void onSelectRole(role)}
              >
                Use {roleLabelFor(role)} workspace
              </button>
            ))}
          </div>
        )}
        <RoleRequestForm
          account={state.account}
          requests={state.requests}
          busy={busy}
          onSubmit={onSubmitRoles}
        />
        <RequestHistory requests={state.requests} />
        <button type="button" className="btn btn-secondary" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </main>
  );
}

function RoleRequestForm({
  account,
  requests,
  busy,
  onSubmit,
}: {
  account: NyumaAccount;
  requests: RoleRequestHistory[];
  busy: boolean;
  onSubmit: (roles: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(selected);
      }}
    >
      <fieldset className="account-roles">
        <legend>Ordinary roles</legend>
        {ORDINARY_ROLES.map((role) => {
          const choice = roleRequestState(role, requests, account.roles);
          const locked = choice === "granted" || choice === "pending";
          return (
            <label key={role} className="account-role" data-role-choice={choice}>
              <span>
                <input
                  type="checkbox"
                  name="roles"
                  value={role}
                  checked={selected.includes(role)}
                  disabled={locked || busy}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
                    )
                  }
                />{" "}
                {roleLabelFor(role)}
              </span>
              <span>{ROLE_COPY[role]}</span>
              <strong>{choiceLabel(choice)}</strong>
            </label>
          );
        })}
      </fieldset>
      <button className="btn btn-secondary" type="submit" disabled={busy}>
        Submit role request
      </button>
    </form>
  );
}

function RequestHistory({ requests }: { requests: RoleRequestHistory[] }) {
  return (
    <div>
      <h2>Requests</h2>
      {requests.length === 0 ? <p className="account-note">No role requests yet.</p> : null}
      <ul className="login-sample">
        {requests.map((request) => (
          <li key={request.id} data-request-status={request.status}>
            {roleLabelFor(request.role)} · {historyLabel(request)}
            {request.decisionNote ? ` · ${request.decisionNote}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusCard({
  title,
  body,
  action,
  onAction,
  children,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <main className="login">
      <section className="login-card account-card" aria-labelledby="account-status-title">
        <a className="brand" href="#top">
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <h1 id="account-status-title">{title}</h1>
        <p>{body}</p>
        <div className="account-actions">
          {action && onAction ? (
            <button type="button" className="btn btn-lime" onClick={onAction}>
              {action}
            </button>
          ) : null}
          {children}
        </div>
      </section>
    </main>
  );
}

function choiceLabel(choice: RoleChoice): string {
  if (choice === "granted") return "Granted";
  if (choice === "pending") return "Requested, waiting for a decision";
  if (choice === "rejected") return "Not approved";
  return "Not requested";
}

function historyLabel(request: RoleRequestHistory): string {
  if (request.granted) return "Granted";
  if (request.status === "pending") return "Requested, waiting for a decision";
  if (request.status === "approved") return "Approved earlier, no longer granted";
  return "Not approved";
}
