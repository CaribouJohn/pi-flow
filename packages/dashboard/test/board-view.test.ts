import { describe, expect, test } from "bun:test";
import type { Slice, Track } from "@pi-flow/flow-engine";
import type { BoardSnapshot, BoardWorld, NeedsYouItem } from "@pi-flow/flowd-cli/board-snapshot";
import {
  DONE_RECENT_CAP,
  needsYouGroups,
  recentDone,
  repoBadge,
  runningGroups,
  ticketUrl,
} from "../src/mainview/lib/board-view.ts";

// ── Fixtures (mirror the helper style in flowd-cli/test/board-snapshot.test.ts) ──

function makeSlice(overrides: Partial<Slice> & { id: number; title: string }): Slice {
  return {
    role: "ready-for-agent",
    effort: undefined,
    review: "agent",
    dependsOn: [],
    assignee: null,
    closed: false,
    branch: null,
    pr: null,
    ...overrides,
  };
}

function makeWorld(over: {
  repo: string;
  trackId: number;
  needsYou?: NeedsYouItem[];
  running?: Slice[];
  done?: Slice[];
  slices?: Slice[];
}): BoardWorld {
  const track: Track = { id: over.trackId, branch: `track/${over.trackId}`, role: "tracking" };
  return {
    repo: over.repo,
    track,
    slices: over.slices ?? [],
    needsYou: over.needsYou ?? [],
    running: over.running ?? [],
    done: over.done ?? [],
  };
}

function makeSnapshot(worlds: BoardWorld[]): BoardSnapshot {
  return {
    generatedAt: 1_700_000_000_000,
    liveness: "dead",
    heartbeat: null,
    worlds,
    lookupWarnings: [],
  };
}

// ── ticketUrl ────────────────────────────────────────────────────────────────

describe("ticketUrl", () => {
  test("builds a github issue URL from repo + id", () => {
    expect(ticketUrl("CaribouJohn/pi-flow", 208)).toBe(
      "https://github.com/CaribouJohn/pi-flow/issues/208",
    );
  });
});

describe("repoBadge", () => {
  test("strips the owner from owner/name", () => {
    expect(repoBadge("CaribouJohn/pi-flow")).toBe("pi-flow");
  });
  test("returns the input when there is no slash", () => {
    expect(repoBadge("pi-flow")).toBe("pi-flow");
  });
});

// ── NEEDS YOU sub-grouping by reason ───────────────────────────────────────────

describe("needsYouGroups", () => {
  test("flattens worlds and sub-groups items by reason (first-seen order)", () => {
    const snap = makeSnapshot([
      makeWorld({
        repo: "CaribouJohn/pi-flow",
        trackId: 103,
        needsYou: [
          { id: 1, title: "Accept A", reason: "needs-acceptance" },
          { id: 2, title: "Grill B", reason: "needs-grilling" },
          { id: 3, title: "Accept C", reason: "needs-acceptance" },
        ],
      }),
      makeWorld({
        repo: "other/repo",
        trackId: 200,
        needsYou: [{ id: 4, title: "Triage D", reason: "needs-triage" }],
      }),
    ]);

    const groups = needsYouGroups(snap);
    expect(groups.map((g) => g.reason)).toEqual([
      "needs-acceptance",
      "needs-grilling",
      "needs-triage",
    ]);
    const accept = groups.find((g) => g.reason === "needs-acceptance");
    expect(accept?.items.map((i) => i.id)).toEqual([1, 3]);
    // Items carry their world's repo for the badge.
    expect(accept?.items[0]?.repo).toBe("CaribouJohn/pi-flow");
    expect(groups.find((g) => g.reason === "needs-triage")?.items[0]?.repo).toBe("other/repo");
  });

  test("returns no groups when nothing needs you", () => {
    expect(needsYouGroups(makeSnapshot([makeWorld({ repo: "r", trackId: 1 })]))).toEqual([]);
  });
});

// ── RUNNING grouped by track ───────────────────────────────────────────────────

describe("runningGroups", () => {
  test("one section per world with running slices, carrying track id + repo", () => {
    const snap = makeSnapshot([
      makeWorld({
        repo: "CaribouJohn/pi-flow",
        trackId: 103,
        running: [makeSlice({ id: 10, title: "Build X" }), makeSlice({ id: 11, title: "Build Y" })],
      }),
      makeWorld({ repo: "CaribouJohn/pi-flow", trackId: 104, running: [] }),
    ]);

    const groups = runningGroups(snap);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.trackId).toBe(103);
    expect(groups[0]?.repo).toBe("CaribouJohn/pi-flow");
    expect(groups[0]?.items.map((i) => i.id)).toEqual([10, 11]);
  });

  test("omits worlds with nothing running", () => {
    const snap = makeSnapshot([makeWorld({ repo: "r", trackId: 1, running: [] })]);
    expect(runningGroups(snap)).toEqual([]);
  });
});

// ── DONE recent-cap ─────────────────────────────────────────────────────────────

describe("recentDone", () => {
  test("flattens done across worlds and caps the count", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeSlice({ id: 100 + i, title: `Done ${i}`, closed: true }),
    );
    const snap = makeSnapshot([
      makeWorld({ repo: "CaribouJohn/pi-flow", trackId: 103, done: many }),
    ]);
    const rows = recentDone(snap);
    expect(rows).toHaveLength(DONE_RECENT_CAP);
    expect(rows[0]?.id).toBe(100);
    expect(rows[0]?.repo).toBe("CaribouJohn/pi-flow");
  });

  test("respects a custom cap", () => {
    const done = [
      makeSlice({ id: 1, title: "a", closed: true }),
      makeSlice({ id: 2, title: "b", closed: true }),
      makeSlice({ id: 3, title: "c", closed: true }),
    ];
    const snap = makeSnapshot([makeWorld({ repo: "r", trackId: 1, done })]);
    expect(recentDone(snap, 2).map((r) => r.id)).toEqual([1, 2]);
  });
});
