/**
 * B4 — `/flow-afk` toggle, stub loop, and status widget renderer.
 *
 * This slice ships only the **surface**: the commands flip an in-memory
 * `afkActive` flag, the stub loop body is a `console.log("afk tick")`
 * every few seconds, and the widget renderer is a pure function used by
 * both the loop tick and the mutation hook.
 *
 * The real loop body lands in B8; persistence across `/reload` is B5;
 * the real poll-to-widget refresh wiring is B9. This module exists so
 * those slices have something to wire to.
 *
 * State is module-scoped (single AFK loop per pi session). Multiple
 * commands and the mutation hook all share it.
 */

import type { Snapshot } from "./poller.ts";

export type WidgetSink = {
  /** Pi's `ctx.ui.setWidget(key, lines)` shape, narrowed. */
  setWidget(key: string, lines: string[]): void;
};

const WIDGET_KEY = "flow";

/** Counts derived from the snapshot for the widget. */
export type WidgetCounts = {
  tracksLive: number;
  needsAcceptance: number;
  reviewHuman: number;
  /** `null` = "no assignable" / "blocked-idle". */
  nextAssignable: { issue: number; effort: string | null } | null;
  /** Minutes since the loop last did meaningful work; `null` if active. */
  idleMinutes: number | null;
};

/**
 * Render the status widget into the one-line shape from DESIGN.md
 * §Status widget. Returns an array so callers can `setWidget(key, …)`
 * directly. Includes an AFK-paused banner when applicable.
 */
export function renderStatusWidget(args: {
  afkActive: boolean;
  afkPaused?: boolean; // true when persistence (B5) replays "was on" but didn't auto-resume
  counts: WidgetCounts;
}): string[] {
  const lines: string[] = [];
  if (args.afkPaused) {
    lines.push("flow · AFK paused · /flow-afk to resume");
    return lines;
  }
  const c = args.counts;
  const next = c.nextAssignable
    ? `next: #${c.nextAssignable.issue}${c.nextAssignable.effort ? ` (${c.nextAssignable.effort})` : ""}`
    : "next: —";
  const idle =
    c.idleMinutes !== null ? `idle ${c.idleMinutes}m` : "running";
  const head = args.afkActive ? "flow · AFK" : "flow";
  lines.push(
    `${head} · ${c.tracksLive} track${c.tracksLive === 1 ? "" : "s"} live · ${next} · ${c.needsAcceptance} needs-acceptance · ${c.reviewHuman} review:human · ${idle}`,
  );
  return lines;
}

/**
 * Derive counts from a snapshot. Pure: no I/O. Uses the canonical
 * label strings (caller must pass them — they come from the profile).
 *
 * Tracks-live = open issues with the `tracking` label.
 * needs-acceptance / review:human = counts of those labels on open issues.
 * nextAssignable: caller passes the next-assignable hint from
 * `flow_next_assignable` (we don't recompute here — that tool already
 * encodes the dependency rules).
 */
export function deriveCounts(args: {
  snapshot: Snapshot | null;
  labels: {
    tracking: string;
    needsAcceptance: string;
    reviewHuman: string;
  };
  nextAssignable: WidgetCounts["nextAssignable"];
  idleMinutes: number | null;
}): WidgetCounts {
  const c: WidgetCounts = {
    tracksLive: 0,
    needsAcceptance: 0,
    reviewHuman: 0,
    nextAssignable: args.nextAssignable,
    idleMinutes: args.idleMinutes,
  };
  if (!args.snapshot) return c;
  for (const issue of args.snapshot.issues.values()) {
    if (issue.state !== "OPEN") continue;
    if (issue.labels.includes(args.labels.tracking)) c.tracksLive++;
    if (issue.labels.includes(args.labels.needsAcceptance)) c.needsAcceptance++;
    if (issue.labels.includes(args.labels.reviewHuman)) c.reviewHuman++;
  }
  return c;
}

// --- AFK state (module-scoped, one per pi session) ---

export type StubTicker = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

/**
 * Make a stub ticker that logs `"afk tick"` at the given cadence. The
 * real loop body lands in B8 — this is the seam.
 *
 * Injected `interval` mirrors `setInterval`'s shape so the smoke can
 * use a fake instead of real timers.
 */
export function makeStubTicker(opts: {
  cadenceMs?: number;
  log?: (msg: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
} = {}): StubTicker {
  const cadenceMs = opts.cadenceMs ?? 5000;
  const log = opts.log ?? ((m) => console.log(m));
  const si =
    opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const ci =
    opts.clearInterval ?? ((h) => globalThis.clearInterval(h as never));

  let handle: unknown = null;
  return {
    start() {
      if (handle !== null) return;
      handle = si(() => log("afk tick"), cadenceMs);
    },
    stop() {
      if (handle === null) return;
      ci(handle);
      handle = null;
    },
    isRunning() {
      return handle !== null;
    },
  };
}

export type AfkState = {
  isActive(): boolean;
  setActive(v: boolean): void;
  ticker: StubTicker;
};

export function createAfkState(ticker: StubTicker): AfkState {
  let active = false;
  return {
    isActive: () => active,
    setActive: (v) => {
      active = v;
    },
    ticker,
  };
}

// --- B5: persistence replay ---

/** Shape of the entry we append on every AFK toggle. */
export type AfkEntry = {
  afkActive: boolean;
  ts: number;
  /** Future-proofing: the tracks this AFK session was scoped to. Empty
   *  array = all open tracks (current behaviour). */
  tracks?: number[];
};

/** Narrow view of `ctx.sessionManager.getEntries()` we actually read. */
export type ReplayEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

export const AFK_ENTRY_TYPE = "flow-afk";

/**
 * Walk the session entries (oldest → newest, as `getEntries` returns them)
 * and return the most recent AFK entry's payload, or `null` if none.
 *
 * Pure: no I/O. The caller supplies the entries; the smoke passes a
 * canned array.
 */
export function replayAfkEntries(entries: ReplayEntry[]): AfkEntry | null {
  let latest: AfkEntry | null = null;
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== AFK_ENTRY_TYPE) continue;
    const d = e.data;
    if (
      d &&
      typeof d === "object" &&
      "afkActive" in d &&
      typeof (d as { afkActive: unknown }).afkActive === "boolean"
    ) {
      latest = d as AfkEntry;
    }
  }
  return latest;
}

/**
 * Decide what the widget should render on `session_start`. Per
 * DESIGN.md §Trigger: do NOT auto-resume across pi restarts — if the
 * last entry was "on", surface the paused banner instead.
 */
export function deriveStartupWidget(
  latest: AfkEntry | null,
): { afkPaused: boolean } {
  return { afkPaused: latest?.afkActive === true };
}
