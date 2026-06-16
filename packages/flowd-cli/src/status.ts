/**
 * `flowd status` — read-only summary of all tracking parents + daemon liveness.
 *
 * Pure functions (`computeLiveness`, `formatStatus`, `sliceDerivedState`) are
 * fully unit-testable without I/O; `runStatus` wires them to real adapters.
 *
 * Heartbeat path: `.flowd/daemon-heartbeat.json` — operator-local and gitignored
 * (`.flowd/` is already in `.gitignore`).  The daemon slice writes this file once
 * per tick; this module only reads it.
 */

import { readFile } from "node:fs/promises";
import {
  type Slice,
  type World,
  isAssignable,
  isBlocked,
  isImplemented,
  isInProgress,
  isReviewed,
} from "@pi-flow/flow-engine";
import { FileCredentialStore } from "./credentials.ts";
import { makeForgeGhRunner, makeForgeRunner, readForgeToken } from "./forge-auth.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { type GhRunner, GitHubTrackerAdapter } from "./github-tracker.ts";

// ── Heartbeat schema ──────────────────────────────────────────────────────────

/**
 * Contract the daemon slice writes once per tick.
 * Stored at `.flowd/daemon-heartbeat.json` (operator-local, gitignored).
 */
export interface DaemonHeartbeat {
  /** ISO-8601 timestamp of the last completed tick. */
  lastTickAt: string;
  /** Human-readable description of what the daemon last did. */
  activity: string;
  /** Running count of consecutive tick errors (reset on success). */
  consecutiveErrors: number;
  /** OS PID of the daemon process. */
  pid: number;
}

/** Daemon liveness classification derived from heartbeat age. */
export type Liveness = "alive" | "stale" | "dead";

/** Default poll cadence (ms) — daemon writes the heartbeat once per tick. */
export const DEFAULT_POLL_CADENCE_MS = 60_000;

/** Operator-local heartbeat path (gitignored via `.flowd/`). */
export const HEARTBEAT_PATH = ".flowd/daemon-heartbeat.json";

// ── Pure: liveness ────────────────────────────────────────────────────────────

/**
 * Classify daemon liveness from the heartbeat age relative to the poll cadence.
 *
 * - `alive`:  age ≤ 2 × cadence  (daemon is running normally)
 * - `stale`:  age ≤ 10 × cadence (daemon may be stuck or restarting)
 * - `dead`:   age > 10 × cadence, or no heartbeat file
 */
export function computeLiveness(
  heartbeat: DaemonHeartbeat | null,
  now: number,
  pollCadenceMs: number = DEFAULT_POLL_CADENCE_MS,
): Liveness {
  if (heartbeat === null) return "dead";
  const age = now - new Date(heartbeat.lastTickAt).getTime();
  if (age <= 2 * pollCadenceMs) return "alive";
  if (age <= 10 * pollCadenceMs) return "stale";
  return "dead";
}

// ── Pure: slice display state ─────────────────────────────────────────────────

/**
 * Derive a human-readable state label for a slice using the engine's derive
 * functions (SPEC §4, invariant #5 — never stored, always recomputed).
 *
 * Priority order (highest wins):
 *   closed              → done
 *   ready-for-human |
 *   needs-acceptance    → needs-you
 *   in-progress +
 *     reviewed PR       → reviewed
 *   in-progress + PR    → in-review
 *   in-progress         → in-progress
 *   blocked             → blocked
 *   assignable          → ready
 *   otherwise           → the role label
 */
export function sliceDerivedState(slice: Slice, world: World): string {
  if (slice.closed) return "done";
  if (slice.role === "ready-for-human" || slice.role === "needs-acceptance") return "needs-you";
  if (isInProgress(slice)) {
    if (isReviewed(slice)) return "reviewed";
    if (isImplemented(slice)) return "in-review";
    return "in-progress";
  }
  if (isBlocked(slice, world)) return "blocked";
  if (isAssignable(slice, world)) return "ready";
  return slice.role;
}

// ── Pure: formatter ───────────────────────────────────────────────────────────

/** Inputs to the pure status formatter. */
export interface FormatStatusInput {
  worlds: World[];
  heartbeat: DaemonHeartbeat | null;
  liveness: Liveness;
  now: number;
}

/**
 * Format a human-readable status report from pre-computed world snapshots.
 * Pure — no I/O; safe to call in tests with fixture data.
 *
 * Output shape:
 *   daemon: alive  pid=1234  last-tick=42s ago  "claimed #7"
 *
 *   track #5  2/3 done  [1 NEEDS YOU]
 *     #10  Add login  [done]
 *     #11  Add dashboard  [in-progress]
 *     #12  Final review  [needs-you]
 *
 *   NEEDS YOU: 1
 */
export function formatStatus(input: FormatStatusInput): string {
  const lines: string[] = [];
  const { liveness, heartbeat, now, worlds } = input;

  // Daemon liveness line
  if (liveness === "alive" && heartbeat !== null) {
    const age = formatAge(now - new Date(heartbeat.lastTickAt).getTime());
    lines.push(
      `daemon: alive  pid=${heartbeat.pid}  last-tick=${age} ago  "${heartbeat.activity}"`,
    );
  } else if (liveness === "stale" && heartbeat !== null) {
    const age = formatAge(now - new Date(heartbeat.lastTickAt).getTime());
    lines.push(`daemon: stale  last-tick=${age} ago  (may be stuck or restarting)`);
  } else {
    lines.push("daemon: absent");
  }

  if (worlds.length === 0) {
    lines.push("");
    lines.push("no tracking parents found");
    lines.push("");
    lines.push("NEEDS YOU: 0");
    return lines.join("\n");
  }

  let needsYouTotal = 0;

  for (const world of worlds) {
    const { track, slices } = world;
    lines.push("");

    const done = slices.filter((s) => s.closed).length;
    const needsYou = slices.filter(
      (s) => !s.closed && (s.role === "ready-for-human" || s.role === "needs-acceptance"),
    ).length;
    needsYouTotal += needsYou;

    const needsYouTag = needsYou > 0 ? `  [${needsYou} NEEDS YOU]` : "";
    lines.push(`track #${track.id}  ${done}/${slices.length} done${needsYouTag}`);

    for (const slice of slices) {
      const state = sliceDerivedState(slice, world);
      lines.push(`  #${slice.id}  ${slice.title}  [${state}]`);
    }
  }

  lines.push("");
  lines.push(`NEEDS YOU: ${needsYouTotal}`);
  return lines.join("\n");
}

/** Format a millisecond duration as a compact human string. */
function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// ── I/O: heartbeat reader ─────────────────────────────────────────────────────

/**
 * Read and parse the daemon heartbeat file.
 * Returns `null` when the file is absent, unreadable, or malformed.
 */
export async function readHeartbeat(
  path: string = HEARTBEAT_PATH,
): Promise<DaemonHeartbeat | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const h = parsed as Record<string, unknown>;
    if (
      typeof h.lastTickAt !== "string" ||
      typeof h.activity !== "string" ||
      typeof h.consecutiveErrors !== "number" ||
      typeof h.pid !== "number"
    ) {
      return null;
    }
    return {
      lastTickAt: h.lastTickAt,
      activity: h.activity,
      consecutiveErrors: h.consecutiveErrors,
      pid: h.pid,
    };
  } catch {
    return null;
  }
}

// ── I/O: tracking-parent discovery ───────────────────────────────────────────

async function listTrackingParents(repo: string, run: GhRunner): Promise<Array<{ id: number }>> {
  const out = await run([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    "tracking",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number",
  ]);
  return (JSON.parse(out) as Array<{ number: number }>).map((i) => ({ id: i.number }));
}

// ── Status runner ─────────────────────────────────────────────────────────────

/** Minimal config shape needed by `runStatus`. */
export interface StatusConfig {
  repo: string;
  workdir: string;
  /** Default branch of the repo (used by the forge adapter). */
  defaultBranch: string;
  /** Path to the credential store JSON. */
  credentialsPath: string;
}

/**
 * Recompute the world (all tracking parents + slice states) from tracker + git,
 * read the daemon heartbeat for liveness, and return a formatted status report.
 *
 * Works without a running daemon — heartbeat absent → liveness `dead`.
 */
export async function runStatus(
  config: StatusConfig,
  opts: { heartbeatPath?: string; pollCadenceMs?: number } = {},
): Promise<string> {
  const credentials = new FileCredentialStore(config.credentialsPath);
  const forgeToken = await readForgeToken(credentials);
  const ghRun = makeForgeGhRunner(forgeToken);
  const cmdRun = makeForgeRunner(forgeToken);

  // Build adapters for read-only queries.
  // trackBranch is passed but only used by getTrack() which status doesn't call.
  const tracker = new GitHubTrackerAdapter({
    repo: config.repo,
    trackBranch: "track/status-placeholder",
    run: ghRun,
  });
  const forge = new GitForgeAdapter({
    repo: config.repo,
    workdir: config.workdir,
    defaultBranch: config.defaultBranch,
    run: cmdRun,
  });

  // Discover all open tracking parents.
  const parents = await listTrackingParents(config.repo, ghRun);

  // Build a World per track by reading slices + their forge state.
  const worlds: World[] = await Promise.all(
    parents.map(async (parent): Promise<World> => {
      const trackerSlices = await tracker.listSlices(parent.id);
      const slices: Slice[] = await Promise.all(
        trackerSlices.map(async (ts) => ({
          ...ts,
          branch: await forge.getSliceBranch(ts.id).catch(() => null),
          pr: await forge.getSlicePr(ts.id).catch(() => null),
        })),
      );
      return {
        track: { id: parent.id, branch: `track/${parent.id}`, role: "tracking" },
        slices,
      };
    }),
  );

  // Read heartbeat and compute liveness.
  const heartbeatPath = opts.heartbeatPath ?? HEARTBEAT_PATH;
  const heartbeat = await readHeartbeat(heartbeatPath);
  const now = Date.now();
  const liveness = computeLiveness(heartbeat, now, opts.pollCadenceMs);

  return formatStatus({ worlds, heartbeat, liveness, now });
}
