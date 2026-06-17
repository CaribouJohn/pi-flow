// Pure, framework-free view logic for the board — all the column/subgroup
// mapping, recent-DONE selection, and URL building live here so they are
// unit-testable headlessly. The React component just maps over these results.
//
// Type-only import from flowd-cli — erased at vite build; no node code leaks in.
import type { BoardSnapshot, BoardWorld, NeedsYouItem } from "@pi-flow/flowd-cli/board-snapshot";

/** Cap on the DONE column. Slices carry no close timestamp, so we cannot sort by
 *  recency — we take the first N as they appear across worlds. */
export const DONE_RECENT_CAP = 15;

/** A NEEDS YOU item enriched with the repo it belongs to (for the badge). */
export interface NeedsYouRow extends NeedsYouItem {
  repo: string;
}

/** A NEEDS YOU sub-group: a reason and the items sharing it. */
export interface NeedsYouGroup {
  reason: string;
  items: NeedsYouRow[];
}

/** One running item (a non-closed, non-bookend slice) with display fields. */
export interface RunningRow {
  id: number;
  title: string;
  repo: string;
}

/** A RUNNING section: one per track that has running slices. */
export interface RunningGroup {
  trackId: number;
  repo: string;
  items: RunningRow[];
}

/** One DONE item. */
export interface DoneRow {
  id: number;
  title: string;
  repo: string;
}

/** Build the ticket URL for a slice/track. Click-through opens this externally. */
export function ticketUrl(repo: string, id: number): string {
  return `https://github.com/${repo}/issues/${id}`;
}

/**
 * NEEDS YOU column: flatten every world's `needsYou`, sub-grouped by `reason`
 * (needs-acceptance, ready-for-human, plan-gate escalation, review:human,
 * needs-grilling, needs-triage, …). Groups appear in first-seen order; items
 * keep their per-world order.
 */
export function needsYouGroups(snapshot: BoardSnapshot): NeedsYouGroup[] {
  const groups: NeedsYouGroup[] = [];
  const byReason = new Map<string, NeedsYouGroup>();
  for (const world of snapshot.worlds) {
    for (const item of world.needsYou) {
      let group = byReason.get(item.reason);
      if (group === undefined) {
        group = { reason: item.reason, items: [] };
        byReason.set(item.reason, group);
        groups.push(group);
      }
      group.items.push({ ...item, repo: world.repo });
    }
  }
  return groups;
}

/**
 * RUNNING column: one section per world with a non-empty `running` list,
 * keyed by track id. Worlds with nothing running are omitted.
 */
export function runningGroups(snapshot: BoardSnapshot): RunningGroup[] {
  const groups: RunningGroup[] = [];
  for (const world of snapshot.worlds) {
    if (world.running.length === 0) continue;
    groups.push({
      trackId: world.track.id,
      repo: world.repo,
      items: world.running.map((s) => ({ id: s.id, title: s.title, repo: world.repo })),
    });
  }
  return groups;
}

/**
 * DONE column: recent closed slices across all worlds, capped at
 * {@link DONE_RECENT_CAP}. No close timestamp exists on a slice, so this is
 * first-N order across worlds rather than true recency.
 */
export function recentDone(snapshot: BoardSnapshot, cap: number = DONE_RECENT_CAP): DoneRow[] {
  const rows: DoneRow[] = [];
  for (const world of snapshot.worlds) {
    for (const s of world.done) {
      rows.push({ id: s.id, title: s.title, repo: world.repo });
    }
  }
  return rows.slice(0, cap);
}

/** Short repo badge — the repo name without the owner (owner/name → name). */
export function repoBadge(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

// Re-export for the component's convenience (single import site).
export type { BoardSnapshot, BoardWorld };
