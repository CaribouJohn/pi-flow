/**
 * `flowd status` — read-only summary of all tracking parents + daemon liveness.
 *
 * This module is the **upper layer**: the human-readable text formatter
 * (`formatStatus`, pure) and the `runStatus` I/O that fetches the worlds and
 * builds a {@link BoardSnapshot}. The snapshot model + classification + liveness
 * live in `board-snapshot.ts` (the lower layer, shared with the dashboard) and
 * are re-exported here for back-compat.
 *
 * Heartbeat path: `.flowd/daemon-heartbeat.json` — operator-local and gitignored
 * (`.flowd/` is already in `.gitignore`).  The daemon slice writes this file once
 * per tick; this module only reads it.
 */

import { readFile } from "node:fs/promises";
import type { PullRequest, Slice, World } from "@pi-flow/flow-engine";
import {
  type BoardSnapshot,
  type DaemonHeartbeat,
  HEARTBEAT_PATH,
  buildBoardSnapshot,
  computeLiveness,
  sliceDerivedState,
} from "./board-snapshot.ts";
import { FileCredentialStore } from "./credentials.ts";
import { makeForgeGhRunner, makeForgeRunner, readForgeToken } from "./forge-auth.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { type GhRunner, GitHubTrackerAdapter } from "./github-tracker.ts";

// Re-export the lower-layer surface so existing importers (daemon.ts, tests)
// keep working unchanged, and the dashboard can pull the snapshot model from
// either entry point.
export {
  HUMAN_BOOKEND_ROLES,
  classifyNeedsYou,
  computeLiveness,
  sliceDerivedState,
  buildBoardSnapshot,
  DEFAULT_POLL_CADENCE_MS,
  HEARTBEAT_PATH,
} from "./board-snapshot.ts";
export type {
  NeedsYouItem,
  DaemonHeartbeat,
  Liveness,
  BoardWorld,
  BoardSnapshot,
} from "./board-snapshot.ts";

// ── Pure: formatter ───────────────────────────────────────────────────────────

/**
 * Format a human-readable status report from a {@link BoardSnapshot}.
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
export function formatStatus(snapshot: BoardSnapshot): string {
  const lines: string[] = [];
  const { liveness, heartbeat, generatedAt: now, worlds } = snapshot;

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
    lines.push("");

    const done = world.done.length;
    const needsYou = world.needsYou.length;
    needsYouTotal += needsYou;

    const needsYouTag = needsYou > 0 ? `  [${needsYou} NEEDS YOU]` : "";
    lines.push(`track #${world.track.id}  ${done}/${world.slices.length} done${needsYouTag}`);

    // sliceDerivedState needs a World; reconstruct it from the board world.
    const asWorld: World = { track: world.track, slices: world.slices };
    for (const slice of world.slices) {
      const state = sliceDerivedState(slice, asWorld);
      lines.push(`  #${slice.id}  ${slice.title}  [${state}]`);
    }
  }

  lines.push("");
  lines.push(`NEEDS YOU: ${needsYouTotal}`);

  const warnings = snapshot.lookupWarnings ?? [];
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
    const status = h.status;
    return {
      lastTickAt: h.lastTickAt,
      activity: h.activity,
      consecutiveErrors: h.consecutiveErrors,
      pid: h.pid,
      ...(status === "ok" || status === "degraded" || status === "halted" ? { status } : {}),
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

  // Assemble the shared snapshot, then format it (the dashboard builds the same
  // snapshot and renders it instead of formatting — one source of truth).
  const snapshot = buildBoardSnapshot({
    worlds,
    heartbeat,
    liveness,
    now,
    repo: config.repo,
    lookupWarnings,
  });
  return formatStatus(snapshot);
}
