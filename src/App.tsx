import { useEffect, useMemo, useState } from "react";
import { About } from "./components/About";
import { AccessDenied } from "./components/AccessDenied";
import { AccountAccess, type AccountMode } from "./components/AccountAccess";
import { AccountExperience } from "./components/AccountExperience";
import { RoleWorkspace } from "./components/RoleWorkspace";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { LoginScreen } from "./components/LoginScreen";
import { isWorkspaceHash, viewForHash } from "./lib/access";
import { clearSession, readSession, writeSession, type KeyValueStore, type SessionUser } from "./lib/auth";
import { createNyumaClient, readApiBaseUrl } from "./lib/nyumaApi";
import { createPendingGateway, createUnconfiguredGateway, loadConfiguredGateway, readPublishableConfig } from "./lib/supabaseAccount";
import { useAccountSession } from "./lib/useAccountSession";

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function authMode(hash: string): AccountMode | null {
  if (hash === "#register") return "register";
  if (hash === "#sign-in") return "sign-in";
  if (hash === "#reset") return "reset";
  return null;
}

function trackedHash(hash: string): boolean {
  return isWorkspaceHash(hash) || hash === "#login" || authMode(hash) !== null || hash === "#account";
}

export function App() {
  const publishable = useMemo(
    () => readPublishableConfig({ url: import.meta.env.VITE_SUPABASE_URL, anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY }) !== null,
    [],
  );
  const [gateway, setGateway] = useState(() => (publishable ? createPendingGateway() : createUnconfiguredGateway()));
  useEffect(() => {
    if (!publishable) return;
    let cancel = false;
    void loadConfiguredGateway()
      .then((next) => {
        if (!cancel) setGateway(next);
      })
      .catch(() => {
        if (!cancel) setGateway(createUnconfiguredGateway());
      });
    return () => {
      cancel = true;
    };
  }, [publishable]);
  const api = useMemo(() => {
    const config = readApiBaseUrl(import.meta.env.VITE_NYUMA_API_URL);
    return config.ok ? createNyumaClient(config.url) : null;
  }, []);
  const account = useAccountSession(gateway, api);
  const [hash, setHash] = useState(() => window.location.hash);
  const [session, setSession] = useState<SessionUser | null>(() => {
    const store = browserStore();
    return store ? readSession(store) : null;
  });
  const view = useMemo(() => viewForHash(hash, session), [hash, session]);
  const accountHolds =
    account.state.phase === "restoring" ||
    account.state.phase === "onboarding" ||
    account.state.phase === "choose-workspace" ||
    account.state.phase === "workspace" ||
    account.state.phase === "disabled" ||
    account.state.phase === "error";

  useEffect(() => {
    function onHashChange() {
      const next = window.location.hash;
      setHash((current) => {
        if (trackedHash(current) !== trackedHash(next)) window.scrollTo(0, 0);
        return next;
      });
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (accountHolds) return;
    const current = window.location.hash;
    if (isWorkspaceHash(current) && !session && current !== "#login") window.location.hash = "#login";
    if (current === "#login" && session) window.location.hash = "#workspace";
  }, [hash, session, accountHolds]);

  useEffect(() => {
    const current = window.location.hash;
    if (account.state.phase === "workspace") {
      if (current === "#account") return;
      if (!isWorkspaceHash(current)) window.location.hash = "#workspace";
      return;
    }
    if (
      (account.state.phase === "onboarding" || account.state.phase === "choose-workspace") &&
      isWorkspaceHash(current)
    ) {
      window.location.hash = "#account";
    }
  }, [account.state.phase, hash]);

  function completeSignIn(user: SessionUser) {
    const store = browserStore();
    if (!store || !writeSession(store, user)) return;
    setSession(readSession(store));
    window.location.hash = "#workspace";
  }

  function signOut() {
    const store = browserStore();
    if (store) clearSession(store);
    setHash("#top");
    setSession(null);
    window.location.hash = "#top";
  }

  if (accountHolds) {
    return (
      <AccountExperience
        state={account.state}
        hash={hash}
        busy={account.busy}
        onSubmitRoles={account.submitRoles}
        onSelectRole={account.selectRole}
        onSignOut={account.signOut}
        onRetry={account.retry}
        api={api}
        onExpire={account.expire}
        onSuspend={account.suspend}
        onReconcile={() => void account.reconcile()}
      />
    );
  }

  const mode = authMode(hash);
  if (mode) {
    return (
      <AccountAccess
        key={mode}
        mode={mode}
        configured={gateway.configured && api !== null}
        notice={account.state.phase === "signed-out" ? account.state.notice : null}
        busy={account.busy}
        onLogin={account.login}
        onRegister={account.register}
        onReset={account.resetPassword}
      />
    );
  }

  if (view === "login") {
    return <LoginScreen onSuccess={completeSignIn} />;
  }

  if (view === "denied" && session) {
    return <AccessDenied user={session} onSignOut={signOut} />;
  }

  if (view === "workspace" && session) {
    return <RoleWorkspace user={session} hash={hash} onSignOut={signOut} />;
  }

  return (
    <>
      <a className="skip-link" href="#how-it-works">
        Skip to how it works
      </a>
      <Header />
      <main>
        <Hero />
        <HowItWorks />
        <About />
      </main>
      <Footer />
    </>
  );
}
