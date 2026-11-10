import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthSession } from "../lib/accountFlow";
import type { NyumaAccount, RoleRequestHistory } from "../lib/nyumaApi";
import type { AccountUiState } from "../lib/useAccountSession";
import { AccountAccess } from "./AccountAccess";
import { AccountExperience } from "./AccountExperience";

const session: AuthSession = { accessToken: "access-token-for-tests", email: "ada@example.com" };

function account(roles: NyumaAccount["roles"], activeRole: NyumaAccount["activeRole"] = null): NyumaAccount {
  return { id: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3", status: "active", roles, activeRole };
}

function request(role: RoleRequestHistory["role"], status: RoleRequestHistory["status"], granted = false): RoleRequestHistory {
  return {
    id: `${role}-${status}`,
    role,
    status,
    requestedAt: "2026-11-05T00:00:00.000Z",
    decidedAt: null,
    decisionNote: status === "rejected" ? "Not this season" : null,
    granted,
  };
}

function ready(phase: "onboarding" | "choose-workspace" | "workspace", current: NyumaAccount, requests: RoleRequestHistory[]): AccountUiState {
  return { phase, session, account: current, requests, notice: null };
}

function page(state: AccountUiState, hash = "#account"): string {
  return renderToStaticMarkup(
    <AccountExperience
      state={state}
      hash={hash}
      busy={false}
      onSubmitRoles={async () => undefined}
      onSelectRole={async () => undefined}
      onSignOut={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

describe("account experience", () => {
  it("shows ordinary roles and keeps a pending request out of the workspace", () => {
    const html = page(ready("onboarding", account([]), [request("farmer", "pending"), request("buyer", "rejected")]));
    expect(html).toContain("Request a role");
    expect(html).toContain("Record the produce you expect to sell.");
    expect(html).toContain("Coordinate supply between farmers and buyers.");
    expect(html).toContain("Describe the produce you want to purchase.");
    expect(html).toContain("Requested, waiting for a decision");
    expect(html).toContain("Not approved");
    expect(html).not.toContain("Use Farmer workspace");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Revoke");
    expect(html.toLowerCase()).not.toContain("administrator");
    expect(html).not.toContain(session.accessToken);
  });

  it("offers only granted roles and explains a revoked workspace", () => {
    const html = page(
      ready("choose-workspace", account(["farmer", "trader"], "buyer"), [request("buyer", "pending"), request("farmer", "approved", true)]),
    );
    expect(html).toContain("Use Farmer workspace");
    expect(html).toContain("Use Trader workspace");
    expect(html).not.toContain("Use Buyer workspace");
    expect(html).toContain("That workspace is no longer available.");
    expect(html).toContain("Granted");
    expect(html).not.toContain(session.accessToken);
  });

  it("does not claim an account was created when sign-in is not configured", () => {
    const html = renderToStaticMarkup(
      <AccountAccess
        mode="register"
        configured={false}
        notice={null}
        busy={false}
        onLogin={async () => undefined}
        onRegister={async () => "confirmation"}
        onReset={async () => undefined}
      />,
    );
    expect(html).toContain("No account was created.");
    expect(html).toContain("does not grant a farmer, trader, or buyer role");
    expect(html.toLowerCase()).not.toContain("administrator");
  });

  it("shows an expired session without a token", () => {
    const html = renderToStaticMarkup(
      <AccountAccess
        mode="sign-in"
        configured={true}
        notice="Your session has expired. Sign in again."
        busy={false}
        onLogin={async () => undefined}
        onRegister={async () => "confirmation"}
        onReset={async () => undefined}
      />,
    );
    expect(html).toContain("Your session has expired. Sign in again.");
    expect(html).toContain("Reset password");
    expect(html).not.toContain(session.accessToken);
  });
});
