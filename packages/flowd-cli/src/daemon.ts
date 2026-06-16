/**
 * `flowd daemon` — continuous loop over ONE track.
 *
 * Loop: tick → drive the track to a fixpoint/park (via tickFn) → write
 * heartbeat → sleep poll_cadence → repeat.  Graceful SIGINT/SIGTERM shutdown:
 * finishes or cleanly abandons the current tick, writes a final heartbeat,
 * then returns (caller exits 0).
 *
 * All I/O and timing dependencies are injectable so the loop can be
 * unit-tested without real timers or filesystem access.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunResult } from "@pi-flow/flow-engine";
import type { FlowdConfig } from "./config.ts";
import {
  DEFAULT_POLL_CADENCE_MS,
  type DaemonHeartbeat,
  HEARTBEAT_PATH,
  type NeedsYouItem,
} from "./status.ts";

/** Injectable dependencies for the daemon loop — enables unit testing. */
export interface DaemonDeps {
  /** Drive the track one full tick to a fixpoint or park. */
  tickFn: (config: FlowdConfig, trackId: number) => Promise<RunResult>;
  /**
   * Write a heartbeat object to the given path.
   * Failures are swallowed by the loop — never fatal.
   */
  writeHeartbeat: (hb: DaemonHeartbeat, path: string) => Promise<void>;
  /** Sleep for `ms` milliseconds before the next tick. */
  sleep: (ms: number) => Promise<void>;
  /** Return the current epoch time in ms (injectable for deterministic tests). */
  now: () => number;
  /** Poll cadence in ms. Default: DEFAULT_POLL_CADENCE_MS (60 s). */
  pollCadenceMs?: number;
  /** Heartbeat file path. Default: HEARTBEAT_PATH. */
  heartbeatPath?: string;
  /**
   * Structured log emitter (one call per tick).
   * Default: `JSON.stringify` → stdout.
   */
  log?: (line: Record<string, unknown>) => void;
  /**
   * Return the current NEEDS YOU items for the track world.
   * Called after each successful tick so the daemon can surface new
   * human-bookend items exactly once (de-duped via a per-run seen-set).
   * Absent or throwing → treated as an empty list (non-fatal).
   */
  needsYouFn?: (config: FlowdConfig, trackId: number) => Promise<NeedsYouItem[]>;
}

/**
 * Write a DaemonHeartbeat as JSON to `path`, creating parent directories.
 * Used by the real (non-test) wiring in `index.ts`.
 */
export async function writeHeartbeatToPath(hb: DaemonHeartbeat, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(hb, null, 2)}\n`, "utf8");
}

/**
 * Run the daemon loop for one track.
 *
 * Registers SIGINT/SIGTERM handlers that set a `stopping` flag; the loop
 * finishes the current tick cleanly, writes a final heartbeat, then returns.
 *
 * An optional `signal` (AbortSignal) provides the same stop mechanism without
 * touching process signals — use it in unit tests to avoid interfering with
 * the test runner's own signal handling.
 */
export async function runDaemon(
  config: FlowdConfig,
  trackId: number,
  deps: DaemonDeps,
  signal?: AbortSignal,
): Promise<void> {
  const {
    tickFn,
    writeHeartbeat,
    sleep,
    now,
    pollCadenceMs = DEFAULT_POLL_CADENCE_MS,
    heartbeatPath = HEARTBEAT_PATH,
    log = (line) => console.log(JSON.stringify(line)),
  } = deps;

  let stopping = false;
  let consecutiveErrors = 0;
  /** Ids of items already logged as NEEDS YOU this daemon run. */
  const seenNeedsYou = new Set<number>();

  const stop = (): void => {
    stopping = true;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  // If the signal was already aborted before we registered the listener,
  // the 'abort' event won't fire retroactively — check upfront.
  if (signal?.aborted) stopping = true;

  try {
    while (!stopping) {
      const tickStart = now();
      let activity: string;
      let outcome: string;
      let stepCount: number;

      try {
        const result = await tickFn(config, trackId);
        consecutiveErrors = 0;
        stepCount = result.steps.length;
        outcome = result.outcome;

        if (result.steps.length === 0) {
          // Nothing to do — at fixpoint already.
          activity = "fixpoint—sleeping";
        } else {
          // Describe the last action taken this tick.
          const last = result.steps.at(-1);
          if (last === undefined) {
            activity = "fixpoint—sleeping";
          } else {
            activity =
              last.detail !== undefined
                ? `${last.action} #${last.sliceId} — ${last.detail}`
                : `${last.action} #${last.sliceId}`;
          }
        }

        log({
          ts: new Date(tickStart).toISOString(),
          track: trackId,
          outcome,
          steps: stepCount,
          activity,
        });

        // Classify NEEDS YOU items and log once per new entry.
        if (deps.needsYouFn !== undefined) {
          let needsYouItems: NeedsYouItem[] = [];
          try {
            needsYouItems = await deps.needsYouFn(config, trackId);
          } catch {
            // Non-fatal: classification failure never stops the daemon.
          }
          for (const item of needsYouItems) {
            if (!seenNeedsYou.has(item.id)) {
              seenNeedsYou.add(item.id);
              log({
                ts: new Date(now()).toISOString(),
                track: trackId,
                needsYou: item.id,
                reason: item.reason,
                message: `🔔 NEEDS YOU #${item.id} — ${item.reason}`,
              });
            }
          }
        }
      } catch (err) {
        consecutiveErrors++;
        activity = `error: ${err instanceof Error ? err.message : String(err)}`;
        outcome = "error";
        stepCount = 0;

        log({
          ts: new Date(tickStart).toISOString(),
          track: trackId,
          outcome,
          consecutiveErrors,
          error: activity,
        });
      }

      // Write the per-tick heartbeat. Failures are non-fatal.
      const hb: DaemonHeartbeat = {
        lastTickAt: new Date(now()).toISOString(),
        activity,
        consecutiveErrors,
        pid: process.pid,
      };
      await writeHeartbeat(hb, heartbeatPath).catch(() => {});

      // Check stopping flag BEFORE sleeping so a signal received during the
      // tick (or inside writeHeartbeat) exits without an extra sleep.
      if (stopping) break;

      await sleep(pollCadenceMs);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);

    // Final heartbeat so `flowd status` shows a clean shutdown.
    const finalHb: DaemonHeartbeat = {
      lastTickAt: new Date(now()).toISOString(),
      activity: "shutdown",
      consecutiveErrors,
      pid: process.pid,
    };
    await writeHeartbeat(finalHb, heartbeatPath).catch(() => {});
  }
}
