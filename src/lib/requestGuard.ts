import { useEffect, useRef } from "react";

/** Ignores a response that started before a newer request, logout, or account change. */
export interface RequestGuard {
  issue(): number;
  current(): number;
  accept(ticket: number): boolean;
  invalidate(): void;
}

export function createRequestGuard(): RequestGuard {
  let generation = 0;
  return {
    issue() {
      generation += 1;
      return generation;
    },
    current() {
      return generation;
    },
    accept(ticket: number) {
      return ticket === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export type SessionSignal = "sign-out" | "disabled" | "show-error";

/** 401 ends the session. 403 account-disabled closes the workspace without logout. Other errors stay on the page. */
export function sessionSignal(code: string): SessionSignal {
  if (code === "unauthenticated") return "sign-out";
  if (code === "account-disabled") return "disabled";
  return "show-error";
}

export async function finishIfCurrent<T>(
  guard: RequestGuard,
  ticket: number,
  work: Promise<T>,
): Promise<{ status: "current"; value: T } | { status: "stale" } | { status: "failed"; error: unknown }> {
  try {
    const value = await work;
    if (!guard.accept(ticket)) return { status: "stale" };
    return { status: "current", value };
  } catch (error) {
    if (!guard.accept(ticket)) return { status: "stale" };
    return { status: "failed", error };
  }
}

export function useRequestGuard(identity: string): RequestGuard {
  const guardRef = useRef<RequestGuard | null>(null);
  if (!guardRef.current) guardRef.current = createRequestGuard();
  const guard = guardRef.current;
  useEffect(() => {
    return () => {
      guard.invalidate();
    };
  }, [guard, identity]);
  return guard;
}
