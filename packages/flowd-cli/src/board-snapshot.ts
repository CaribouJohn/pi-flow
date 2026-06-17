/**
 * Board snapshot — the typed, framework-free view model the dashboard renders
 * and `flowd status` formats.
 *
 * It reuses the engine's `World` reducer + `classifyNeedsYou` (SPEC §8.5) and
 * the derive predicates (SPEC §4): the board **never re-derives** lifecycle
 * state, it consumes exactly what the engine computes (SPEC §0, one source of
 * truth). See PRD-0002 / ADR-0039.
 *
 * Layering: this is the lower layer — pure classification + the snapshot
 * builder, unit-testable with fixtures and free of any I/O. `status.ts` is the
 * upper layer (the text formatter + the `runStatus` I/O that fetches the
 * worlds); it re-exports the symbols below for back-compat.
 */

import {
  type Role,
  type Slice,
  type Track,
  type World,
  isAssignable,
  isBlocked,
  isImplemented,
  isInProgress,
  isReviewed,
} from "@pi-flow/flow-engine";

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
  /**
   * Daemon health status (PRD-0005 §4.1).
   * - `ok`       — last tick succeeded, backoff reset.
   * - `degraded` — last tick threw a transient error; backing off + retrying.
   * - `halted`   — last tick threw a fatal error; process is exiting non-zero.
   * Absent in heartbeats written before this field was added.
   */
  status?: "ok" | "degraded" | "halted";
}

/** Daemon liveness classification derived from heartbeat age. */
export type Liveness = "alive" | "stale" | "dead";

/** Default poll cadence (ms) — daemon writes the heartbeat once per tick. */
export const DEFAULT_POLL_CADENCE_MS = 60_000;

/** Operator-local heartbeat path (gitignored via `.flowd/`). */
export const HEARTBEAT_PATH = ".flowd/daemon-heartbeat.json";

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

// ── Slice display state ────────────────────────────────────────────────────────

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

// ── Board snapshot ──────────────────────────────────────────────────────────────

/**
 * One track's worth of board data: the engine's `World` plus the three column
 * groupings the board renders (NEEDS YOU / RUNNING / DONE). Carries `repo` so
 * the model is multi-repo-shaped from day one (v1 populates a single repo).
 *
 * The three groups partition the slices: `done` = closed; `needsYou` =
 * `classifyNeedsYou` (non-closed bookend/escalation items, may include the
 * track parent); `running` = every other non-closed slice (the autonomously
 * active ones).
 */
export interface BoardWorld {
  /** The repo this track lives in (e.g. `owner/name`). */
  repo: string;
  track: Track;
  slices: Slice[];
  /** NEEDS YOU items (SPEC §8.5) — may include the track parent. */
  needsYou: NeedsYouItem[];
  /** Non-closed slices not awaiting a human — the autonomous middle. */
  running: Slice[];
  /** Closed slices. */
  done: Slice[];
}

/**
 * The whole board, derived once from (tracker + git) + the daemon heartbeat.
 * Multi-repo-shaped via `worlds[]`; v1 populates one repo's tracking parents.
 */
export interface BoardSnapshot {
  /** Wall-clock (ms) the snapshot was assembled — used for liveness display. */
  generatedAt: number;
  liveness: Liveness;
  heartbeat: DaemonHeartbeat | null;
  worlds: BoardWorld[];
  /** Operational warnings collected while fetching forge data (branch/PR lookups). */
  lookupWarnings: string[];
}

/** Inputs to the pure {@link buildBoardSnapshot} builder. */
export interface BuildBoardSnapshotInput {
  worlds: World[];
  heartbeat: DaemonHeartbeat | null;
  liveness: Liveness;
  now: number;
  /** Repo each world belongs to (multi-repo-shaped; v1 passes one). Defaults to "". */
  repo?: string;
  lookupWarnings?: string[];
}

/**
 * Assemble a {@link BoardSnapshot} from pre-fetched worlds + heartbeat. Pure —
 * no I/O — so it is fully unit-testable with fixtures. The NEEDS YOU / RUNNING /
 * DONE groupings are derived solely from the engine (`classifyNeedsYou` + the
 * `closed` flag); the board never re-implements lifecycle derivation (SPEC §0).
 */
export function buildBoardSnapshot(input: BuildBoardSnapshotInput): BoardSnapshot {
  const repo = input.repo ?? "";
  const worlds = input.worlds.map((world): BoardWorld => {
    const needsYou = classifyNeedsYou(world);
    const needsYouIds = new Set(needsYou.map((i) => i.id));
    const done = world.slices.filter((s) => s.closed);
    const running = world.slices.filter((s) => !s.closed && !needsYouIds.has(s.id));
    return { repo, track: world.track, slices: world.slices, needsYou, running, done };
  });
  return {
    generatedAt: input.now,
    liveness: input.liveness,
    heartbeat: input.heartbeat,
    worlds,
    lookupWarnings: input.lookupWarnings ?? [],
  };
}
