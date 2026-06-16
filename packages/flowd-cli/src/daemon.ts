/**
 * `flowd daemon` — continuous loop over ALL `tracking` parents (or ONE track
 * when `--track <n>` is supplied as a debug override).
 *
 * Each cycle: derive the set of `tracking` parent IDs (via
 * `listTrackingParentsFn`) → drive each to a fixpoint/park sequentially →
 * write heartbeat → sleep poll_cadence → repeat.  Cross-track parallelism is
 * explicitly deferred (PRD-0005 §3); runs are single-threaded.
 *
 * Graceful SIGINT/SIGTERM shutdown: finishes or cleanly abandons the current
 * tick, writes a final heartbeat, then returns (caller exits 0).
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

/**
 * PRD-location convention (T12 auto-slice):
 *
 * A `needs-slicing` (or `needs-plan-review`) parent issue must contain a line
 * in its body in the form:
 *
 *   PRD: docs/prd/NNNN-title.md
 *
 * The path is relative to the repository root.  The daemon reads this marker
 * each cycle; changing the path in the issue body re-points the slicer.
 * Issues without a `PRD:` marker are silently excluded from auto-slicing.
 */

/** Injectable dependencies for the daemon loop — enables unit testing. */
export interface DaemonDeps {
  /** Drive the track one full tick to a fixpoint or park. */
  tickFn: (config: FlowdConfig, trackId: number) => Promise<RunResult>;
  /**
   * Return the issue numbers of all open `tracking` parents each cycle.
   * Called at the start of every cycle when `runDaemon` is started without a
   * single-track override (`trackId === undefined`).  Absent or throwing →
   * treated as a transient error (degraded + backoff).  Ignored when
   * `trackId` is provided to `runDaemon`.
   */
  listTrackingParentsFn?: (config: FlowdConfig) => Promise<number[]>;
  /**
   * List `needs-slicing` parents that have a `PRD: <path>` body marker
   * (see PRD-location convention above).  Each entry carries the parsed PRD
   * path.  Issues without the marker are excluded by the implementation.
   * Called each cycle when both this and `sliceFn` are provided.
   * Absent → phase A is skipped.  Throwing → treated as a transient error.
   */
  listNeedsSlicingFn?: (config: FlowdConfig) => Promise<{ id: number; prdPath: string }[]>;
  /**
   * Drive a `needs-slicing` parent through T12 (auto-slice) + T13/T14
   * (plan gate).  Maps to `runPlan({ issue, prdPath, config })`.
   * Called once per item returned by `listNeedsSlicingFn`.
   * Absent → phase A is skipped even when `listNeedsSlicingFn` is provided.
   */
  sliceFn?: (config: FlowdConfig, trackId: number, prdPath: string) => Promise<void>;
  /**
   * List `needs-plan-review` parents that have a `PRD: <path>` body marker.
   * Called each cycle when both this and `planFn` are provided.
   * Absent → phase B is skipped.  Throwing → treated as a transient error.
   */
  listNeedsPlanReviewFn?: (config: FlowdConfig) => Promise<{ id: number; prdPath: string }[]>;
  /**
   * Drive a `needs-plan-review` parent through T13/T14 (plan gate, idempotent
   * re-run).  Maps to `runPlan({ issue, prdPath, config })`.
   * Called once per item returned by `listNeedsPlanReviewFn`.
   * Absent → phase B is skipped even when `listNeedsPlanReviewFn` is provided.
   */
  planFn?: (config: FlowdConfig, trackId: number, prdPath: string) => Promise<void>;
  /**
   * List tracking parents whose every non-acceptance slice is closed —
   * i.e. the track is complete and ready for the A1 accept-stage.
   * Called each cycle when both this and `acceptFn` are provided.
   * Absent → phase D is skipped.  Throwing → treated as a transient error.
   */
  listAcceptReadyFn?: (config: FlowdConfig) => Promise<number[]>;
  /**
   * Open/update the track→main PR for a completed track (A1 accept-stage,
   * SPEC §5.5).  Maps to `acceptTrack({ track, config })`.
   * Called once per item returned by `listAcceptReadyFn`.
   * Never merges main (invariant #1) — that authority rests with the human.
   * Absent → phase D is skipped even when `listAcceptReadyFn` is provided.
   */
  acceptFn?: (config: FlowdConfig, trackId: number) => Promise<void>;
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
 * Run the daemon loop.
 *
 * When `trackId` is provided, the daemon drives that single track each cycle
 * (single-track mode: `--track <n>` override for debugging).  When `trackId`
 * is `undefined`, the daemon calls `deps.listTrackingParentsFn` at the start
 * of every cycle and drives each returned tracking parent in order
 * (all-tracks mode, PRD-0005 §3).
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
  trackId: number | undefined,
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
      let cycleActivity = "fixpoint\u2014sleeping";
      let cycleStatus: "ok" | "degraded" | "halted" = "ok";
      let sleepDuration = pollCadenceMs;

      // ── Derive track IDs for this cycle ───────────────────────────────────
      // Single-track override: trackId arg is defined → always [trackId].
      // All-tracks mode: derive from listTrackingParentsFn each cycle.
      //
      // cycleAborted: set to true on any listing or dispatch error so
      // subsequent phases are skipped and the cycle sleeps with backoff.
      let cycleAborted = false;
      let trackIds: number[];
      if (trackId !== undefined) {
        trackIds = [trackId];
      } else if (deps.listTrackingParentsFn !== undefined) {
        try {
          trackIds = await deps.listTrackingParentsFn(config);
          // The listing call succeeded — treat this as a recovery point.
          // A previous cycle may have left consecutiveErrors / backoffMs set
          // from a transient listing failure; reset them now so a subsequent
          // per-track transient error starts its own fresh backoff sequence
          // rather than compounding with the already-recovered list error.
          consecutiveErrors = 0;
          backoffMs = 0;
        } catch (err) {
          consecutiveErrors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const kind = classifyError(err);

          if (kind === "fatal") {
            // ── Fatal while listing tracks ──────────────────────────────────
            const activity = `halted: ${errMsg}`;
            log({
              ts: new Date(tickStart).toISOString(),
              outcome: "halted",
              consecutiveErrors,
              error: errMsg,
              message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
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
            return;
          }

          // ── Transient: degrade + backoff, skip tracks this cycle ──────────
          cycleActivity = `error: ${errMsg}`;
          cycleStatus = "degraded";
          backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
          sleepDuration = backoffMs;
          log({
            ts: new Date(tickStart).toISOString(),
            outcome: "degraded",
            consecutiveErrors,
            error: cycleActivity,
            backoffMs,
          });
          trackIds = []; // skip track loop this cycle
          cycleAborted = true; // skip new phases too
        }
      } else {
        trackIds = [];
      }

      // ── Phase A: needs-slicing → T12 (slicer) + T13/T14 (plan gate) ───────
      // Lists `needs-slicing` parents with a PRD: body marker each cycle and
      // calls sliceFn (→ runPlan) for each.  Idempotent: re-running at any
      // reached state is a no-op inside runPlan (SPEC §8.8).
      let slicingItems: { id: number; prdPath: string }[] = [];
      if (!cycleAborted && deps.listNeedsSlicingFn !== undefined) {
        try {
          slicingItems = await deps.listNeedsSlicingFn(config);
        } catch (err) {
          consecutiveErrors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const kind = classifyError(err);
          if (kind === "fatal") {
            const activity = `halted: ${errMsg}`;
            log({
              ts: new Date(tickStart).toISOString(),
              outcome: "halted",
              consecutiveErrors,
              error: errMsg,
              message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
            });
            await writeHeartbeat(
              {
                lastTickAt: new Date(now()).toISOString(),
                activity,
                consecutiveErrors,
                status: "halted",
                pid: process.pid,
              },
              heartbeatPath,
            ).catch(() => {});
            haltedForFatal = true;
            exitFn(1);
            return;
          }
          cycleActivity = `error: ${errMsg}`;
          cycleStatus = "degraded";
          backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
          sleepDuration = backoffMs;
          log({
            ts: new Date(tickStart).toISOString(),
            outcome: "degraded",
            consecutiveErrors,
            error: cycleActivity,
            backoffMs,
          });
          cycleAborted = true;
        }
      }
      if (!cycleAborted && deps.sliceFn !== undefined) {
        for (const item of slicingItems) {
          if (stopping || cycleAborted) break;
          try {
            await deps.sliceFn(config, item.id, item.prdPath);
            consecutiveErrors = 0;
            backoffMs = 0;
            cycleActivity = `slice #${item.id}`;
            cycleStatus = "ok";
            log({ ts: new Date(tickStart).toISOString(), track: item.id, action: "slice" });
          } catch (err) {
            consecutiveErrors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            const kind = classifyError(err);
            if (kind === "fatal") {
              const activity = `halted: ${errMsg}`;
              log({
                ts: new Date(tickStart).toISOString(),
                track: item.id,
                outcome: "halted",
                consecutiveErrors,
                error: errMsg,
                message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
              });
              await writeHeartbeat(
                {
                  lastTickAt: new Date(now()).toISOString(),
                  activity,
                  consecutiveErrors,
                  status: "halted",
                  pid: process.pid,
                },
                heartbeatPath,
              ).catch(() => {});
              haltedForFatal = true;
              exitFn(1);
              return;
            }
            cycleActivity = `error: ${errMsg}`;
            cycleStatus = "degraded";
            backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
            sleepDuration = backoffMs;
            log({
              ts: new Date(tickStart).toISOString(),
              track: item.id,
              outcome: "degraded",
              consecutiveErrors,
              error: cycleActivity,
              backoffMs,
            });
            cycleAborted = true;
            break;
          }
        }
      }

      // ── Phase B: needs-plan-review → T13/T14 (plan gate, idempotent) ───────
      // Lists `needs-plan-review` parents with a PRD: body marker each cycle
      // and calls planFn (→ runPlan, idempotent re-run) for each.
      let planReviewItems: { id: number; prdPath: string }[] = [];
      if (!cycleAborted && deps.listNeedsPlanReviewFn !== undefined) {
        try {
          planReviewItems = await deps.listNeedsPlanReviewFn(config);
        } catch (err) {
          consecutiveErrors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const kind = classifyError(err);
          if (kind === "fatal") {
            const activity = `halted: ${errMsg}`;
            log({
              ts: new Date(tickStart).toISOString(),
              outcome: "halted",
              consecutiveErrors,
              error: errMsg,
              message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
            });
            await writeHeartbeat(
              {
                lastTickAt: new Date(now()).toISOString(),
                activity,
                consecutiveErrors,
                status: "halted",
                pid: process.pid,
              },
              heartbeatPath,
            ).catch(() => {});
            haltedForFatal = true;
            exitFn(1);
            return;
          }
          cycleActivity = `error: ${errMsg}`;
          cycleStatus = "degraded";
          backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
          sleepDuration = backoffMs;
          log({
            ts: new Date(tickStart).toISOString(),
            outcome: "degraded",
            consecutiveErrors,
            error: cycleActivity,
            backoffMs,
          });
          cycleAborted = true;
        }
      }
      if (!cycleAborted && deps.planFn !== undefined) {
        for (const item of planReviewItems) {
          if (stopping || cycleAborted) break;
          try {
            await deps.planFn(config, item.id, item.prdPath);
            consecutiveErrors = 0;
            backoffMs = 0;
            cycleActivity = `plan-gate #${item.id}`;
            cycleStatus = "ok";
            log({ ts: new Date(tickStart).toISOString(), track: item.id, action: "plan-gate" });
          } catch (err) {
            consecutiveErrors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            const kind = classifyError(err);
            if (kind === "fatal") {
              const activity = `halted: ${errMsg}`;
              log({
                ts: new Date(tickStart).toISOString(),
                track: item.id,
                outcome: "halted",
                consecutiveErrors,
                error: errMsg,
                message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
              });
              await writeHeartbeat(
                {
                  lastTickAt: new Date(now()).toISOString(),
                  activity,
                  consecutiveErrors,
                  status: "halted",
                  pid: process.pid,
                },
                heartbeatPath,
              ).catch(() => {});
              haltedForFatal = true;
              exitFn(1);
              return;
            }
            cycleActivity = `error: ${errMsg}`;
            cycleStatus = "degraded";
            backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
            sleepDuration = backoffMs;
            log({
              ts: new Date(tickStart).toISOString(),
              track: item.id,
              outcome: "degraded",
              consecutiveErrors,
              error: cycleActivity,
              backoffMs,
            });
            cycleAborted = true;
            break;
          }
        }
      }

      // ── Phase C: tracking → build loop (existing) ─────────────────────────
      // ── Drive each track to fixpoint/park sequentially ────────────────────
      for (const tid of trackIds) {
        if (stopping || cycleAborted) break;

        try {
          const result = await tickFn(config, tid);
          consecutiveErrors = 0;
          backoffMs = 0; // reset backoff on success

          const stepCount = result.steps.length;
          const outcome = result.outcome;
          let activity: string;

          if (stepCount === 0) {
            // Nothing to do — at fixpoint already.
            activity = "fixpoint\u2014sleeping";
          } else {
            // Describe the last action taken this tick.
            const last = result.steps.at(-1);
            activity =
              last === undefined
                ? "fixpoint\u2014sleeping"
                : last.detail !== undefined
                  ? `${last.action} #${last.sliceId} \u2014 ${last.detail}`
                  : `${last.action} #${last.sliceId}`;
          }

          cycleActivity = activity;
          cycleStatus = "ok";

          log({
            ts: new Date(tickStart).toISOString(),
            track: tid,
            outcome,
            steps: stepCount,
            activity,
          });

          // Classify NEEDS YOU items and log once per new entry.
          if (deps.needsYouFn !== undefined) {
            let needsYouItems: NeedsYouItem[] = [];
            try {
              needsYouItems = await deps.needsYouFn(config, tid);
            } catch {
              // Non-fatal: classification failure never stops the daemon.
            }
            for (const item of needsYouItems) {
              if (!seenNeedsYou.has(item.id)) {
                seenNeedsYou.add(item.id);
                log({
                  ts: new Date(now()).toISOString(),
                  track: tid,
                  needsYou: item.id,
                  reason: item.reason,
                  message: `\ud83d\udd14 NEEDS YOU #${item.id} \u2014 ${item.reason}`,
                });
              }
            }
          }
        } catch (err) {
          consecutiveErrors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const kind = classifyError(err);

          if (kind === "fatal") {
            // ── Fatal error: halt the daemon immediately ──────────────────────
            const activity = `halted: ${errMsg}`;
            log({
              ts: new Date(tickStart).toISOString(),
              track: tid,
              outcome: "halted",
              consecutiveErrors,
              error: errMsg,
              message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
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

          // ── Transient error: back off and stop remaining tracks this cycle ──
          const activity = `error: ${errMsg}`;
          cycleActivity = activity;
          cycleStatus = "degraded";
          backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
          sleepDuration = backoffMs;
          log({
            ts: new Date(tickStart).toISOString(),
            track: tid,
            outcome: "degraded",
            consecutiveErrors,
            error: activity,
            backoffMs,
          });
          cycleAborted = true; // skip Phase D (accept) this cycle
          break; // stop processing further tracks in this cycle
        }
      }

      // ── Phase D: accept-ready → A1 (accept stage) ──────────────────────────
      // Lists tracking parents whose non-acceptance slices are all closed and
      // calls acceptFn (→ acceptTrack) to open/update the track→main PR.
      // Never merges main (invariant #1) — merge authority rests with the human.
      let acceptReadyIds: number[] = [];
      if (!cycleAborted && deps.listAcceptReadyFn !== undefined) {
        try {
          acceptReadyIds = await deps.listAcceptReadyFn(config);
        } catch (err) {
          consecutiveErrors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const kind = classifyError(err);
          if (kind === "fatal") {
            const activity = `halted: ${errMsg}`;
            log({
              ts: new Date(tickStart).toISOString(),
              outcome: "halted",
              consecutiveErrors,
              error: errMsg,
              message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
            });
            await writeHeartbeat(
              {
                lastTickAt: new Date(now()).toISOString(),
                activity,
                consecutiveErrors,
                status: "halted",
                pid: process.pid,
              },
              heartbeatPath,
            ).catch(() => {});
            haltedForFatal = true;
            exitFn(1);
            return;
          }
          cycleActivity = `error: ${errMsg}`;
          cycleStatus = "degraded";
          backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
          sleepDuration = backoffMs;
          log({
            ts: new Date(tickStart).toISOString(),
            outcome: "degraded",
            consecutiveErrors,
            error: cycleActivity,
            backoffMs,
          });
          cycleAborted = true;
        }
      }
      if (!cycleAborted && deps.acceptFn !== undefined) {
        for (const tid of acceptReadyIds) {
          if (stopping || cycleAborted) break;
          try {
            await deps.acceptFn(config, tid);
            consecutiveErrors = 0;
            backoffMs = 0;
            cycleActivity = `accept #${tid}`;
            cycleStatus = "ok";
            log({ ts: new Date(tickStart).toISOString(), track: tid, action: "accept" });
          } catch (err) {
            consecutiveErrors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            const kind = classifyError(err);
            if (kind === "fatal") {
              const activity = `halted: ${errMsg}`;
              log({
                ts: new Date(tickStart).toISOString(),
                track: tid,
                outcome: "halted",
                consecutiveErrors,
                error: errMsg,
                message: `\ud83d\udc80 FATAL: ${errMsg} \u2014 daemon halted`,
              });
              await writeHeartbeat(
                {
                  lastTickAt: new Date(now()).toISOString(),
                  activity,
                  consecutiveErrors,
                  status: "halted",
                  pid: process.pid,
                },
                heartbeatPath,
              ).catch(() => {});
              haltedForFatal = true;
              exitFn(1);
              return;
            }
            cycleActivity = `error: ${errMsg}`;
            cycleStatus = "degraded";
            backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
            sleepDuration = backoffMs;
            log({
              ts: new Date(tickStart).toISOString(),
              track: tid,
              outcome: "degraded",
              consecutiveErrors,
              error: cycleActivity,
              backoffMs,
            });
            cycleAborted = true;
            break;
          }
        }
      }

      // Write the per-cycle heartbeat. Failures are non-fatal.
      const hb: DaemonHeartbeat = {
        lastTickAt: new Date(now()).toISOString(),
        activity: cycleActivity,
        consecutiveErrors,
        status: cycleStatus,
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
