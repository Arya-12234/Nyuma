import { useContext, useEffect, useRef, useState } from "react";
import type { BuyerDemand, Commitment, Listing, Outcome, Purchase } from "../../domain/records";
import { loadWorkspaceRecords, reduceWorkspaceLoad } from "../../lib/accountCoordination";
import type { SessionUser } from "../../lib/auth";
import { browserCoordinationRepository } from "../../lib/coordinationClient";
import { useRequestGuard } from "../../lib/requestGuard";
import { CoordinationAccessContext, reportAccessCode } from "./coordinationAccess";

export type CoordinationLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      listings: readonly Listing[];
      demands: readonly BuyerDemand[];
      commitments: readonly Commitment[];
      purchases: readonly Purchase[];
      outcomes: readonly Outcome[];
    };

export function useCoordination(user?: SessionUser): CoordinationLoad {
  const access = useContext(CoordinationAccessContext);
  const active = user ?? access?.user ?? null;
  const sample = active === null || active.sample === true;
  const accountId = active?.id ?? "sample";
  const token = sample ? null : access?.token ?? null;
  const attempt = access?.attempt ?? 0;
  const guard = useRequestGuard(`${sample}:${accountId}:${token ?? ""}:${attempt}`);
  const accessRef = useRef(access);
  accessRef.current = access;
  const [state, setState] = useState<CoordinationLoad>({ phase: "loading" });

  useEffect(() => {
    const cleared = reduceWorkspaceLoad({ phase: "loading" }, { type: "reset" });
    if (cleared.phase === "loading") setState(cleared);
    const ticket = guard.issue();
    const current = accessRef.current;
    const signedIn = user ?? current?.user ?? null;
    void loadWorkspaceRecords({
      user: signedIn && signedIn.sample === sample ? signedIn : sampleUser(),
      token,
      api: sample ? null : current?.api ?? null,
      sampleRepository: sample ? browserCoordinationRepository() : null,
    }).then((result) => {
      if (!guard.accept(ticket)) return;
      if (!result.ok) {
        const failed = reduceWorkspaceLoad({ phase: "loading" }, { type: "error", message: result.message });
        if (failed.phase === "error") setState(failed);
        reportAccessCode(accessRef.current, result.code);
        return;
      }
      setState({ phase: "ready", ...result.records });
    });
  }, [user, sample, accountId, token, attempt, guard]);

  return state;
}

function sampleUser(): import("../../lib/auth").SessionUser {
  return {
    version: 1,
    id: "sample",
    name: "Sample",
    email: "sample@nyuma.ke",
    role: "farmer",
    sample: true,
  };
}

export function quantityText(value: number | null): string {
  if (value === null) return "None";
  return `${trimNumber(value)} kg`;
}

export function priceText(value: number | null): string {
  if (value === null) return "No price given";
  return `KSh ${trimNumber(value)}/kg`;
}

function trimNumber(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}
