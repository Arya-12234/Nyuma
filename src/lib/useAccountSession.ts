import { useCallback, useEffect, useRef, useState } from "react";
import {
  accountMessage,
  chooseWorkspace,
  createSessionGate,
  holdSubmission,
  openSession,
  releaseSubmission,
  screenForAccount,
  refreshAccount,
  sendRoleRequests,
  submissionNotice,
  type AuthSession,
} from "./accountFlow";
import { NyumaApiError, type NyumaApi, type RoleRequestHistory } from "./nyumaApi";
import { createRequestGuard, finishIfCurrent, sessionSignal } from "./requestGuard";
import type { AccountGateway } from "./supabaseAccount";

export type AccountUiState =
  | { phase: "restoring" }
  | { phase: "unconfigured" }
  | { phase: "signed-out"; notice: string | null }
  | { phase: "disabled"; email: string }
  | { phase: "error"; message: string; session: AuthSession | null }
  | {
      phase: "onboarding" | "choose-workspace" | "workspace";
      session: AuthSession;
      account: import("./nyumaApi").NyumaAccount;
      requests: RoleRequestHistory[];
      notice: string | null;
    };

export function useAccountSession(gateway: AccountGateway, api: NyumaApi | null) {
  const [state, setState] = useState<AccountUiState>(() =>
    gateway.configured ? { phase: "restoring" } : { phase: "unconfigured" },
  );
  const [busy, setBusy] = useState(false);
  const gate = useRef(createSessionGate());
  const lock = useRef({ held: false });
  const flight = useRef(createRequestGuard());
  const apiRef = useRef(api);
  apiRef.current = api;
  const stateRef = useRef(state);
  stateRef.current = state;

  const apply = useCallback((session: AuthSession, loaded: { account: import("./nyumaApi").NyumaAccount; requests: RoleRequestHistory[] }, notice: string | null) => {
    const screen = screenForAccount(loaded.account);
    if (screen === "disabled") {
      setState({ phase: "disabled", email: session.email });
      return;
    }
    setState({ phase: screen, session, account: loaded.account, requests: loaded.requests, notice });
  }, []);

  const fail = useCallback((session: AuthSession | null, error: unknown) => {
    const code = error instanceof NyumaApiError ? error.code : "request-failed";
    const signal = sessionSignal(code);
    flight.current.invalidate();
    gate.current.release();
    if (signal === "sign-out") {
      void gateway.logout().catch(() => undefined);
      setState({ phase: "signed-out", notice: accountMessage(code) });
      window.location.hash = "#sign-in";
      return;
    }
    if (signal === "disabled") {
      setState({ phase: "disabled", email: session?.email ?? "" });
      return;
    }
    setState({ phase: "error", message: accountMessage(code), session });
  }, [gateway]);

  const load = useCallback(async (session: AuthSession, force: boolean) => {
    if (force) gate.current.release();
    const decision = gate.current.claim(session);
    if (decision === "skip") return;
    if (decision === "refresh") {
      const ticket = flight.current.issue();
      setState((current) => ("session" in current ? { ...current, session } : current));
      const client = apiRef.current;
      if (!client) return;
      const finished = await finishIfCurrent(flight.current, ticket, openSession(session.accessToken, client));
      if (finished.status === "stale") return;
      if (finished.status === "failed") {
        fail(session, finished.error);
        return;
      }
      apply(session, finished.value, null);
      return;
    }
    const client = apiRef.current;
    if (!client) {
      fail(session, new NyumaApiError(503, "request-failed"));
      return;
    }
    const ticket = flight.current.issue();
    setState({ phase: "restoring" });
    const finished = await finishIfCurrent(flight.current, ticket, openSession(session.accessToken, client));
    if (finished.status === "stale") return;
    if (finished.status === "failed") {
      fail(session, finished.error);
      return;
    }
    apply(session, finished.value, null);
  }, [apply, fail]);

  useEffect(() => {
    if (!gateway.configured) {
      setState({ phase: "unconfigured" });
      return;
    }
    let cancel = false;
    let ready = false;
    void gateway.restore().then((session) => {
      if (cancel) return;
      ready = true;
      if (!session) setState({ phase: "signed-out", notice: null });
      else void load(session, false);
    });
    const stop = gateway.subscribe((session) => {
      if (cancel || !ready) return;
      if (!session) {
        flight.current.invalidate();
        gate.current.release();
        setState({ phase: "signed-out", notice: null });
        return;
      }
      void load(session, false);
    });
    return () => {
      cancel = true;
      flight.current.invalidate();
      stop();
    };
  }, [gateway, load]);

  async function login(email: string, password: string) {
    if (!holdSubmission(lock.current)) return;
    setBusy(true);
    try {
      const session = await gateway.login(email, password);
      await load(session, true);
    } finally {
      releaseSubmission(lock.current);
      setBusy(false);
    }
  }

  async function register(email: string, password: string): Promise<"confirmation" | "signed-in"> {
    if (!holdSubmission(lock.current)) return "confirmation";
    setBusy(true);
    try {
      const result = await gateway.register(email, password);
      if (!result.session) return "confirmation";
      await load(result.session, true);
      return "signed-in";
    } finally {
      releaseSubmission(lock.current);
      setBusy(false);
    }
  }

  async function resetPassword(email: string) {
    const redirectTo = `${window.location.origin}${window.location.pathname}#sign-in`;
    await gateway.requestPasswordReset(email, redirectTo);
  }

  async function submitRoles(roles: string[]) {
    if (state.phase !== "onboarding" && state.phase !== "choose-workspace" && state.phase !== "workspace") return;
    const current = state;
    const client = apiRef.current;
    if (!client) return;
    if (!holdSubmission(lock.current)) return;
    setBusy(true);
    const ticket = flight.current.current();
    try {
      const finished = await finishIfCurrent(
        flight.current,
        ticket,
        sendRoleRequests(current.session.accessToken, roles, current.requests, current.account.roles, client),
      );
      if (finished.status === "stale") return;
      if (finished.status === "failed") {
        const code = finished.error instanceof NyumaApiError ? finished.error.code : "request-failed";
        if (code === "rate-limited" || code === "invalid-request") {
          setState({ ...current, notice: accountMessage(code) });
          return;
        }
        fail(current.session, finished.error);
        return;
      }
      apply(current.session, finished.value, submissionNotice(finished.value.submissions));
    } catch (error) {
      const code = error instanceof NyumaApiError ? error.code : "request-failed";
      if (code === "rate-limited" || code === "invalid-request") {
        setState({ ...current, notice: accountMessage(code) });
        return;
      }
      fail(current.session, error);
    } finally {
      releaseSubmission(lock.current);
      setBusy(false);
    }
  }

  async function selectRole(role: string) {
    if (state.phase !== "choose-workspace" && state.phase !== "workspace") return;
    const current = state;
    const client = apiRef.current;
    if (!client) return;
    if (!holdSubmission(lock.current)) return;
    setBusy(true);
    const ticket = flight.current.current();
    try {
      const finished = await finishIfCurrent(flight.current, ticket, chooseWorkspace(current.session.accessToken, role, client));
      if (finished.status === "stale") return;
      if (finished.status === "failed") {
        const code = finished.error instanceof NyumaApiError ? finished.error.code : "request-failed";
        if (code === "rate-limited" || code === "invalid-request") {
          setState({ ...current, notice: accountMessage(code) });
          return;
        }
        fail(current.session, finished.error);
        return;
      }
      const result = finished.value;
      apply(current.session, result, result.error ? accountMessage(result.error) : null);
      if (!result.error && screenForAccount(result.account) === "workspace") window.location.hash = "#workspace";
    } catch (error) {
      const code = error instanceof NyumaApiError ? error.code : "request-failed";
      if (code === "rate-limited" || code === "invalid-request") {
        setState({ ...current, notice: accountMessage(code) });
        return;
      }
      fail(current.session, error);
    } finally {
      releaseSubmission(lock.current);
      setBusy(false);
    }
  }

  function signOut() {
    flight.current.invalidate();
    gate.current.release();
    setState({ phase: "signed-out", notice: null });
    window.location.hash = "#top";
    void gateway.logout().catch(() => {
      setState({ phase: "error", message: accountMessage("request-failed"), session: null });
    });
  }

  function retry() {
    if (state.phase === "error" && state.session) void load(state.session, true);
  }

  function expire() {
    flight.current.invalidate();
    gate.current.release();
    void gateway.logout().catch(() => undefined);
    setState({ phase: "signed-out", notice: accountMessage("unauthenticated") });
    window.location.hash = "#sign-in";
  }

  function suspend() {
    flight.current.invalidate();
    const current = stateRef.current;
    const email = "session" in current && current.session ? current.session.email : current.phase === "disabled" ? current.email : "";
    setState({ phase: "disabled", email });
  }

  async function reconcile() {
    const current = stateRef.current;
    if (current.phase !== "workspace" && current.phase !== "choose-workspace" && current.phase !== "onboarding") return;
    const client = apiRef.current;
    if (!client) return;
    const ticket = flight.current.issue();
    const finished = await finishIfCurrent(flight.current, ticket, refreshAccount(current.session.accessToken, client));
    if (finished.status === "stale") return;
    if (finished.status === "failed") {
      const code = finished.error instanceof NyumaApiError ? finished.error.code : "request-failed";
      if (sessionSignal(code) === "show-error") return;
      fail(current.session, finished.error);
      return;
    }
    apply(current.session, finished.value, null);
  }

  return { state, busy, login, register, resetPassword, submitRoles, selectRole, signOut, retry, expire, suspend, reconcile };
}
