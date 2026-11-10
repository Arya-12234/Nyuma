import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { SessionUser } from "../../lib/auth";
import type { NyumaApi } from "../../lib/nyumaApi";

export interface CoordinationAccess {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  attempt: number;
  retry: () => void;
  onUnauthenticated: () => void;
  onAccountDisabled: () => void;
  onAccessDenied: () => void;
}

export const CoordinationAccessContext = createContext<CoordinationAccess | null>(null);

export function CoordinationProvider({
  user,
  token,
  api,
  onUnauthenticated,
  onAccountDisabled,
  onAccessDenied,
  children,
}: {
  user: SessionUser;
  token: string | null;
  api: NyumaApi | null;
  onUnauthenticated: () => void;
  onAccountDisabled?: () => void;
  onAccessDenied?: () => void;
  children: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const value = useMemo<CoordinationAccess>(
    () => ({
      user,
      token: user.sample ? null : token,
      api: user.sample ? null : api,
      attempt,
      retry() {
        setAttempt((current) => current + 1);
      },
      onUnauthenticated,
      onAccountDisabled: onAccountDisabled ?? (() => undefined),
      onAccessDenied: onAccessDenied ?? (() => undefined),
    }),
    [user, token, api, attempt, onUnauthenticated, onAccountDisabled, onAccessDenied],
  );
  return <CoordinationAccessContext.Provider value={value}>{children}</CoordinationAccessContext.Provider>;
}

export function reportAccessCode(access: CoordinationAccess | null, code: string): void {
  if (!access || access.user.sample) return;
  if (code === "unauthenticated") access.onUnauthenticated();
  else if (code === "account-disabled") access.onAccountDisabled();
  else if (code === "role-not-granted" || code === "workspace-not-assigned") access.onAccessDenied();
}

export function CoordinationAlert({ message }: { message: string }) {
  const access = useContext(CoordinationAccessContext);
  return (
    <p role="alert">
      {message}
      {access && access.user.sample === false ? (
        <>
          {" "}
          <button type="button" onClick={() => access.retry()}>
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}
