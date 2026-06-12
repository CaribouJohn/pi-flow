/**
 * Body-parsing helpers for the flow conventions encoded in our issue
 * templates:
 *
 *   `Depends on: #N`       — slice-level dependency on another issue
 *   `**Tracked:** #N`      — slice belongs to track-parent #N
 *
 * Both tolerant of leading whitespace, bold markers (`**`), and multiple
 * occurrences. Numbers are deduplicated.
 *
 * Pure functions; no I/O. Used by `flow_next_assignable` and (later) the
 * status widget.
 */

const STRIP_BOLD = (s: string) => s.replace(/\*\*/g, "");

/**
 * Find every `#N` mentioned on any line that begins with `Depends on:`
 * (case-insensitive, allowing leading whitespace and surrounding bold).
 * Multi-line lists work because each `Depends on:` line is parsed
 * independently.
 */
export function parseDependsOn(body: string): number[] {
  const out = new Set<number>();
  for (const raw of body.split(/\r?\n/)) {
    const line = STRIP_BOLD(raw);
    if (!/^\s*Depends on:/i.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      out.add(Number(m[1]));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * First `Tracked: #N` (or `**Tracked:** #N`) reference in the body.
 * Returns null if not present. We only honour the first occurrence so a
 * slice unambiguously belongs to one track.
 */
export function parseTrackParent(body: string): number | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = STRIP_BOLD(raw);
    const m = line.match(/^\s*Tracked:\s*#(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}
