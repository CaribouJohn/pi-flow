/**
 * B8b — per-issue reviewer-iteration count persistence.
 *
 * Rides the same `pi.appendEntry` / session-replay rails as B5's AFK
 * toggle (see afk-state.ts). A `bump` entry increments the count for
 * one issue; a `reset` entry zeroes it (called on merge or escalate so
 * the count is clean if the issue is ever re-opened and re-picked).
 *
 * All mutable state lives in a caller-held `Map<number, number>` so
 * the B8c wiring can construct it at `session_start` via
 * `replayIterations(entries)` and then pass it into the loop deps as
 * a closure over the same map instance.
 *
 * No I/O in this module — `bumpIteration` / `resetIteration` accept
 * an `append` callback so the smoke can assert calls without touching
 * disk.
 */

export const AFK_ITERATION_ENTRY_TYPE = "pi-flow:afk-iteration";

export type AfkIterationEntry =
  | { kind: "bump"; issueNumber: number; ts: number }
  | { kind: "reset"; issueNumber: number; ts: number };

/** Narrow view of a session entry (same shape as in afk-state.ts). */
export type ReplayEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

/**
 * Walk session entries (oldest → newest) and rebuild the iteration
 * count per issue.
 *
 * Pure: no I/O. Skips non-iteration entries and any malformed payloads
 * (wrong type, missing `kind`/`issueNumber`).
 */
export function replayIterations(entries: ReplayEntry[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== AFK_ITERATION_ENTRY_TYPE) continue;
    const d = e.data;
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    if (typeof rec.issueNumber !== "number") continue;
    if (rec.kind === "bump") {
      counts.set(rec.issueNumber, (counts.get(rec.issueNumber) ?? 0) + 1);
    } else if (rec.kind === "reset") {
      counts.set(rec.issueNumber, 0);
    }
    // unknown kind → skip
  }
  return counts;
}

/**
 * Read the current iteration count for an issue from a previously
 * replayed (or live-updated) map. Returns 0 if no entry exists yet.
 */
export function loadIterationFromMap(
  map: Map<number, number>,
  issueNumber: number,
): number {
  return map.get(issueNumber) ?? 0;
}

/**
 * Append a `bump` entry and update the in-memory map. Returns the
 * **new** count (i.e., what `loadIterationFromMap` would return
 * immediately after this call).
 *
 * `append` is shaped like `pi.appendEntry(type, payload)`.
 */
export async function bumpIteration(
  append: (type: string, payload: unknown) => Promise<void>,
  map: Map<number, number>,
  issueNumber: number,
  ts: number = Date.now(),
): Promise<number> {
  const next = (map.get(issueNumber) ?? 0) + 1;
  map.set(issueNumber, next);
  await append(AFK_ITERATION_ENTRY_TYPE, { kind: "bump", issueNumber, ts } satisfies AfkIterationEntry);
  return next;
}

/**
 * Append a `reset` entry and zero the in-memory map for this issue.
 * Called after a merge or escalation so that if the issue is
 * re-opened and re-picked, the iteration cap starts fresh.
 */
export async function resetIteration(
  append: (type: string, payload: unknown) => Promise<void>,
  map: Map<number, number>,
  issueNumber: number,
  ts: number = Date.now(),
): Promise<void> {
  map.set(issueNumber, 0);
  await append(AFK_ITERATION_ENTRY_TYPE, { kind: "reset", issueNumber, ts } satisfies AfkIterationEntry);
}
