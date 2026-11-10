import { describe, expect, it } from "vitest";
import { reportAccessCode, type CoordinationAccess } from "../components/coordination/coordinationAccess";
import type { SessionUser } from "./auth";
import { createRequestGuard, finishIfCurrent, sessionSignal } from "./requestGuard";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function user(sample: boolean): SessionUser {
  if (sample) {
    return {
      version: 1,
      id: "sample-farmer",
      name: "Sample Farmer",
      email: "farmer@nyuma.ke",
      role: "farmer",
      sample: true,
    };
  }
  return {
    version: 1,
    id: "8a2c1b7e-1c2d-4e5f-a6b7-c8d9e0f1a2b3",
    name: "Account",
    email: "person@example.com",
    role: "farmer",
    sample: false,
    grantedRoles: ["farmer"],
  };
}

function access(sample: boolean, calls: { out: number; disabled: number; denied: number }): CoordinationAccess {
  return {
    user: user(sample),
    token: sample ? null : "token",
    api: null,
    attempt: 0,
    retry() {
      return undefined;
    },
    onUnauthenticated() {
      calls.out += 1;
    },
    onAccountDisabled() {
      calls.disabled += 1;
    },
    onAccessDenied() {
      calls.denied += 1;
    },
  };
}

describe("request generation", () => {
  it("keeps only the later account when the earlier response arrives last", async () => {
    const guard = createRequestGuard();
    let view: string | null = "previous";
    const accountA = guard.issue();
    const accountB = guard.issue();
    const pendingA = finishIfCurrent(guard, accountA, wait(30).then(() => "account-a"));
    const pendingB = finishIfCurrent(guard, accountB, wait(5).then(() => "account-b"));
    const [first, second] = await Promise.all([pendingA, pendingB]);
    if (second.status === "current") view = second.value;
    if (first.status === "current") view = first.value;
    expect(first.status).toBe("stale");
    expect(second.status).toBe("current");
    expect(view).toBe("account-b");
  });

  it("drops a response that arrives after logout", async () => {
    const guard = createRequestGuard();
    let view: string | null = null;
    const ticket = guard.issue();
    const pending = finishIfCurrent(guard, ticket, wait(20).then(() => "should-not-return"));
    guard.invalidate();
    const finished = await pending;
    if (finished.status === "current") view = finished.value;
    expect(finished.status).toBe("stale");
    expect(view).toBeNull();
  });

  it("does not let an older success replace a newer failed load", async () => {
    const guard = createRequestGuard();
    let view: { phase: "ready"; id: string } | { phase: "error" } = { phase: "ready", id: "account-a" };
    const older = guard.issue();
    const newer = guard.issue();
    const [oldResult, newResult] = await Promise.all([
      finishIfCurrent(guard, older, wait(25).then(() => "account-a-again")),
      finishIfCurrent(
        guard,
        newer,
        wait(5).then(() => Promise.reject(new Error("load failed"))),
      ),
    ]);
    if (newResult.status === "failed") view = { phase: "error" };
    if (oldResult.status === "current") view = { phase: "ready", id: oldResult.value };
    expect(oldResult.status).toBe("stale");
    expect(newResult.status).toBe("failed");
    expect(view).toEqual({ phase: "error" });
  });

  it("lets a newer response replace an older one for the same account", async () => {
    const guard = createRequestGuard();
    let view = "old";
    const first = guard.issue();
    const second = guard.issue();
    const [older, newer] = await Promise.all([
      finishIfCurrent(guard, first, wait(20).then(() => "old-records")),
      finishIfCurrent(guard, second, wait(5).then(() => "new-records")),
    ]);
    if (newer.status === "current") view = newer.value;
    if (older.status === "current") view = older.value;
    expect(view).toBe("new-records");
  });
});

describe("session signals", () => {
  it("signs out only for an expired session and keeps permission and validation errors on screen", () => {
    expect(sessionSignal("unauthenticated")).toBe("sign-out");
    expect(sessionSignal("account-disabled")).toBe("disabled");
    expect(sessionSignal("role-not-granted")).toBe("show-error");
    expect(sessionSignal("workspace-not-assigned")).toBe("show-error");
    expect(sessionSignal("not-found")).toBe("show-error");
    expect(sessionSignal("conflict")).toBe("show-error");
    expect(sessionSignal("relationship")).toBe("show-error");
    expect(sessionSignal("invalid-request")).toBe("show-error");
  });

  it("routes 401, a disabled account, and a revoked role without treating a sample user as signed in", () => {
    const real = { out: 0, disabled: 0, denied: 0 };
    const sampleCalls = { out: 0, disabled: 0, denied: 0 };
    reportAccessCode(access(false, real), "unauthenticated");
    reportAccessCode(access(false, real), "account-disabled");
    reportAccessCode(access(false, real), "role-not-granted");
    reportAccessCode(access(false, real), "workspace-not-assigned");
    reportAccessCode(access(false, real), "not-found");
    reportAccessCode(access(false, real), "conflict");
    reportAccessCode(access(true, sampleCalls), "unauthenticated");
    reportAccessCode(access(true, sampleCalls), "account-disabled");
    reportAccessCode(null, "unauthenticated");
    expect(real).toEqual({ out: 1, disabled: 1, denied: 2 });
    expect(sampleCalls).toEqual({ out: 0, disabled: 0, denied: 0 });
  });
});
