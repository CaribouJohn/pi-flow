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
  type PullRequest,
  type Role,
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

// ── §8.5 Human-bookend classifier ────────────────────────────────────────────

/**
 * Role-based human-bookend set (SPEC §8.5).
 * Slices in any of these roles require human action before the agent can
 * proceed.  `review:human` and plan-gate escalation (T14) are derived
 * conditions checked separately in `classifyNeedsYou`.
 */
export const HUMAN_BOOKEND_ROLES = new Set<Role>([
  "needs-triage",
  "needs-grilling",
  "ready-for-human",
  "needs-acceptance",
]);

/** A single item surfaced by the NEEDS YOU classifier. */
export interface NeedsYouItem {
  /** Issue number (track parent or slice). */
  id: number;
  /** Issue title or display label. */
  title: string;
  /** Short human-readable reason (the role or derived condition). */
  reason: string;
}

/**
 * Classify all items in a World that are in human-bookend states (SPEC §8.5).
 *
 * Returns one entry per item needing human attention:
 *   - Track parent in `needs-plan-review` (T14 plan-gate escalation)
 *   - Slices in role-based bookend set: `needs-triage`, `needs-grilling`,
 *     `ready-for-human`, `needs-acceptance`
 *   - `review:human` slices with an open PR (S6h handoff awaiting human reviewer)
 *
 * Closed slices are never included.
 */
export function classifyNeedsYou(world: World): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  // T14: plan-gate escalation — track parent awaiting human decision.
  if (world.track.role === "needs-plan-review") {
    items.push({
      id: world.track.id,
      title: `track #${world.track.id}`,
      reason: "plan-gate escalation",
    });
  }

  for (const slice of world.slices) {
    if (slice.closed) continue;

    // Role-based bookend.
    if (HUMAN_BOOKEND_ROLES.has(slice.role)) {
      items.push({ id: slice.id, title: slice.title, reason: slice.role });
      continue;
    }

    // S6h: review:human slice with an open PR — awaiting human reviewer.
    if (slice.review === "human" && slice.pr !== null && slice.pr.status === "open") {
      items.push({ id: slice.id, title: slice.title, reason: "review:human" });
    }
  }

  return items;
}

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
  /**
   * Operational errors collected while fetching forge data (branch / PR
   * lookups).  When non-empty, the formatter appends a warning block so the
   * user knows the slice states shown may be incomplete.
   */
  lookupWarnings?: string[];
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
  } else if (liveness === "dead" && heartbeat !== null) {
    const age = formatAge(now - new Date(heartbeat.lastTickAt).getTime());
    lines.push(`daemon: dead  last-tick=${age} ago  (process may have crashed)`);
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
    const needsYou = classifyNeedsYou(world).length;
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

  const warnings = input.lookupWarnings ?? [];
  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(w);
    lines.push("");
    lines.push(
      "warning: some slice data may be incomplete — fix the forge errors above and re-run",
    );
  }

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
  //
  // We intentionally do NOT use .catch(() => null) here.  Both getSliceBranch
  // (git ls-remote) and getSlicePr (gh pr list) return null / [] naturally
  // when the branch or PR simply does not exist — they only throw on genuine
  // operational errors (auth failure, network error, permission denied, etc.).
  // Silently returning null on those errors would make slices appear as
  // "in-progress" when they may actually be "reviewed" or "in-review", with
  // no indication that the data is incomplete.  Instead we collect per-slice
  // warnings and surface them in the formatted output.
  const lookupWarnings: string[] = [];

  const worlds: World[] = await Promise.all(
    parents.map(async (parent): Promise<World> => {
      const trackerSlices = await tracker.listSlices(parent.id);
      const slices: Slice[] = await Promise.all(
        trackerSlices.map(async (ts) => {
          let branch: string | null = null;
          let pr: PullRequest | null = null;

          try {
            branch = await forge.getSliceBranch(ts.id);
          } catch (err) {
            lookupWarnings.push(
              `warning: branch lookup failed for #${ts.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          try {
            pr = await forge.getSlicePr(ts.id);
          } catch (err) {
            lookupWarnings.push(
              `warning: PR lookup failed for #${ts.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          return { ...ts, branch, pr };
        }),
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

  return formatStatus({ worlds, heartbeat, liveness, now, lookupWarnings });
}
