/**
 * Scheduler around `flow_poll` (B2). Adaptive cadence per DESIGN.md
 * §AFK heartbeat: **15s** for the first 5 minutes after the loop
 * transitions to blocked, **60s** thereafter.
 *
 * No integration with the AFK loop yet — exposes:
 *   - immediate first tick on `start()`
 *   - subsequent ticks honour the cadence
 *   - `setBlockedSince(ts | null)` toggles cadence
 *   - `onDiff(handler)` subscription (multiple handlers OK)
 *   - `stop()` cancels the next tick, idempotent
 *
 * Clock + timer are injected so the smoke can fast-forward without real
 * timers. The default implementation uses `Date.now` + `setTimeout`.
 *
 * Error handling: a thrown `flowPoll` (e.g. gh non-zero) does NOT halt
 * the scheduler. The error is forwarded to any handlers registered via
 * `onError`, and the next tick is scheduled normally. This matches the
 * AFK loop's "be patient with transient gh failures" stance — a single
 * bad poll is not worth tearing down the heartbeat.
 */

import { flowPoll, type Diff, type PollDeps, type PollOpts, type Snapshot } from "./poller.ts";

export const FAST_CADENCE_MS = 15_000;
export const SLOW_CADENCE_MS = 60_000;
export const FAST_WINDOW_MS = 5 * 60_000; // 5 minutes

export type SchedulerClock = {
  now(): number;
  /** Returns a cancel fn. Must call `fn` after at least `ms` of wall-clock. */
  schedule(fn: () => void, ms: number): () => void;
};

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export type Poller = {
  start(): void;
  stop(): void;
  /** Mark the time the loop went blocked (`null` means "not blocked"). */
  setBlockedSince(ts: number | null): void;
  onDiff(handler: (diffs: Diff[], snapshot: Snapshot) => void): () => void;
  onError(handler: (err: unknown) => void): () => void;
  /** Inspection for tests / status widget. */
  latestSnapshot(): Snapshot | null;
};

export type CreatePollerArgs = {
  pollDeps: PollDeps;
  pollOpts: PollOpts;
  clock?: SchedulerClock;
};

export function createPoller(args: CreatePollerArgs): Poller {
  const clock = args.clock ?? realClock;
  const diffHandlers = new Set<(diffs: Diff[], snapshot: Snapshot) => void>();
  const errorHandlers = new Set<(err: unknown) => void>();

  let latest: Snapshot | null = null;
  let blockedSince: number | null = null;
  let running = false;
  let cancelNext: (() => void) | null = null;

  function cadenceMs(): number {
    if (blockedSince === null) return SLOW_CADENCE_MS;
    const elapsed = clock.now() - blockedSince;
    return elapsed < FAST_WINDOW_MS ? FAST_CADENCE_MS : SLOW_CADENCE_MS;
  }

  async function tick() {
    cancelNext = null;
    if (!running) return;
    try {
      const { snapshot, diffs } = await flowPoll(
        latest,
        args.pollDeps,
        args.pollOpts,
      );
      latest = snapshot;
      for (const h of diffHandlers) {
        try {
          h(diffs, snapshot);
        } catch (err) {
          for (const eh of errorHandlers) eh(err);
        }
      }
    } catch (err) {
      for (const eh of errorHandlers) eh(err);
    } finally {
      if (running) {
        cancelNext = clock.schedule(tick, cadenceMs());
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // First tick immediately (DESIGN.md: spec says "first tick fires
      // immediately"). Schedule with 0ms so error handling still wraps it.
      cancelNext = clock.schedule(tick, 0);
    },
    stop() {
      running = false;
      if (cancelNext) {
        cancelNext();
        cancelNext = null;
      }
    },
    setBlockedSince(ts) {
      blockedSince = ts;
      // Cadence changed — reschedule the pending tick under the new
      // cadence from now. Without this, an unblock between ticks would
      // still let the already-scheduled FAST tick fire.
      if (running && cancelNext) {
        cancelNext();
        cancelNext = clock.schedule(tick, cadenceMs());
      }
    },
    onDiff(h) {
      diffHandlers.add(h);
      return () => diffHandlers.delete(h);
    },
    onError(h) {
      errorHandlers.add(h);
      return () => errorHandlers.delete(h);
    },
    latestSnapshot() {
      return latest;
    },
  };
}
