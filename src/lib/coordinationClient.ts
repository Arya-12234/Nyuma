import { createLocalCoordinationRepository, createSequentialIdGenerator } from "../domain/coordinationRepository";
import type { CoordinationRepository } from "../domain/coordinationRepository";

let cached: CoordinationRepository | null = null;

/** One local repository for this browser tab. Records stay in this browser profile. */
export function browserCoordinationRepository(): CoordinationRepository | null {
  if (cached) return cached;
  try {
    cached = createLocalCoordinationRepository(window.localStorage, {
      clock: { now: () => new Date().toISOString() },
      ids: createSequentialIdGenerator(),
    });
    return cached;
  } catch {
    return null;
  }
}
