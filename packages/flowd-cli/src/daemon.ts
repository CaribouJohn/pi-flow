/**
 * `flowd daemon` — continuous loop over ONE track.
 *
 * Loop: tick → drive the track to a fixpoint/park (via tickFn) → write
 * heartbeat → sleep poll_cadence → repeat.  Graceful SIGINT/SIGTERM shutdown:
 * finishes or cleanly abandons the current tick, writes a final heartbeat,
 * then returns (caller exits 0).
 *
 * Error handling (PRD-0005 §4.1 / SPEC §8.7 "never a silent loop"):
 *   transient (network / 5xx / 429 / timeout)
 *     → increment consecutiveErrors, set `degraded`, sleep capped exponential
 *       backoff, retry.
 *   fatal (auth 401/403, repo 404, config parse/validation, missing credential)
 *     → write `halted` heartbeat, log loudly, call exitFn(1) and return.
 *
 * All I/O and timing dependencies are injectable so the loop can be
 * unit-tested without real timers or filesystem access.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunResult } from "@pi-flow/flow-engine";
import type { FlowdConfig } from "./config.ts";
import { classifyError } from "./error-classifier.ts";
import {
  DEFAULT_POLL_CADENCE_MS,
  type DaemonHeartbeat,
  HEARTBEAT_PATH,
  type NeedsYouItem,
} from "./status.ts";

/** Default base backoff when the first transient error fires (ms). */
export const DEFAULT_BACKOFF_BASE_MS = 5_000;
/** Default maximum backoff cap (ms) — 5 minutes. */
export const DEFAULT_BACKOFF_MAX_MS = 300_000;

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
  /**
   * Called with exit code `1` when a fatal tick error is encountered.
   * Default: `process.exit`.
   * Override in tests to record the call and prevent actual process exit.
   */
  exitFn?: (code: number) => void;
  /**
   * Base backoff duration for the first transient error (ms).
   * Default: DEFAULT_BACKOFF_BASE_MS (5 s).
   * Set lower in tests to avoid long waits with a fake sleep.
   */
  backoffBaseMs?: number;
  /**
   * Maximum backoff cap (ms) — backoff is clamped to this value.
   * Default: DEFAULT_BACKOFF_MAX_MS (5 min).
   */
  backoffMaxMs?: number;
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
 *
 * On a **fatal** error the function writes a `halted` heartbeat, logs loudly,
 * calls `exitFn(1)` (default: `process.exit(1)`), then returns.  In
 * production the process never survives `process.exit`; in tests the injected
 * `exitFn` can record the call without terminating.
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
    exitFn = (code) => process.exit(code),
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  } = deps;

  let stopping = false;
  let consecutiveErrors = 0;
  /** Current backoff duration (ms); 0 = not in backoff (use pollCadenceMs). */
  let backoffMs = 0;
  /** True once a fatal error fires — suppresses the shutdown heartbeat. */
  let haltedForFatal = false;
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
      let status: "ok" | "degraded" | "halted" = "ok";
      let sleepDuration = pollCadenceMs;

      try {
        const result = await tickFn(config, trackId);
        consecutiveErrors = 0;
        backoffMs = 0; // reset backoff on success
        stepCount = result.steps.length;
        outcome = result.outcome;
        status = "ok";

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
        stepCount = 0;
        const errMsg = err instanceof Error ? err.message : String(err);
        const kind = classifyError(err);

        if (kind === "fatal") {
          // ── Fatal error: halt the daemon immediately ──────────────────────
          activity = `halted: ${errMsg}`;
          outcome = "halted";
          status = "halted";

          log({
            ts: new Date(tickStart).toISOString(),
            track: trackId,
            outcome: "halted",
            consecutiveErrors,
            error: errMsg,
            message: `💀 FATAL: ${errMsg} — daemon halted`,
          });

          const haltedHb: DaemonHeartbeat = {
            lastTickAt: new Date(now()).toISOString(),
            activity,
            consecutiveErrors,
            status: "halted",
            pid: process.pid,
          };
          await writeHeartbeat(haltedHb, heartbeatPath).catch(() => {});

          haltedForFatal = true;
          exitFn(1);
          return; // unreachable when exitFn = process.exit; reached in tests
        }

        // ── Transient error: back off and retry ───────────────────────────
        activity = `error: ${errMsg}`;
        outcome = "degraded";
        status = "degraded";

        // Capped exponential backoff.
        backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
        sleepDuration = backoffMs;

        log({
          ts: new Date(tickStart).toISOString(),
          track: trackId,
          outcome: "degraded",
          consecutiveErrors,
          error: activity,
          backoffMs,
        });
      }

      // Write the per-tick heartbeat. Failures are non-fatal.
      const hb: DaemonHeartbeat = {
        lastTickAt: new Date(now()).toISOString(),
        activity,
        consecutiveErrors,
        status,
        pid: process.pid,
      };
      await writeHeartbeat(hb, heartbeatPath).catch(() => {});

      // Check stopping flag BEFORE sleeping so a signal received during the
      // tick (or inside writeHeartbeat) exits without an extra sleep.
      if (stopping) break;

      await sleep(sleepDuration);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);

    // Final heartbeat so `flowd status` shows a clean shutdown.
    // Skipped when a fatal error already wrote a `halted` heartbeat — we
    // do not want to overwrite `halted` with `shutdown`.
    if (!haltedForFatal) {
      const finalHb: DaemonHeartbeat = {
        lastTickAt: new Date(now()).toISOString(),
        activity: "shutdown",
        consecutiveErrors,
        status: "ok",
        pid: process.pid,
      };
      await writeHeartbeat(finalHb, heartbeatPath).catch(() => {});
    }
  }
}
