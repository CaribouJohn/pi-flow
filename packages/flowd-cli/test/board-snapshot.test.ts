import { describe, expect, test } from "bun:test";
import type { Slice, World } from "@pi-flow/flow-engine";
import { buildBoardSnapshot } from "../src/board-snapshot.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function makeWorld(
  trackId: number,
  slices: Slice[],
  trackRole: World["track"]["role"] = "tracking",
): World {
  return {
    track: { id: trackId, branch: `track/${trackId}`, role: trackRole },
    slices,
  };
}

// ── buildBoardSnapshot ───────────────────────────────────────────────────────

describe("buildBoardSnapshot", () => {
  const now = 1_700_000_000_000;

  test("carries liveness, heartbeat, and generatedAt through unchanged", () => {
    const snap = buildBoardSnapshot({ worlds: [], heartbeat: null, liveness: "dead", now });
    expect(snap.generatedAt).toBe(now);
    expect(snap.liveness).toBe("dead");
    expect(snap.heartbeat).toBeNull();
    expect(snap.worlds).toEqual([]);
    expect(snap.lookupWarnings).toEqual([]);
  });

  test("partitions slices into done / needsYou / running with no overlap", () => {
    const done = makeSlice({ id: 10, title: "Done", closed: true });
    const needsYou = makeSlice({ id: 11, title: "Accept", role: "needs-acceptance" });
    const running = makeSlice({ id: 12, title: "Build", role: "ready-for-agent", assignee: "bot" });
    const world = makeWorld(5, [done, needsYou, running]);

    const [bw] = buildBoardSnapshot({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
    }).worlds;
    if (!bw) throw new Error("expected one board world");

    expect(bw.done.map((s) => s.id)).toEqual([10]);
    expect(bw.needsYou.map((i) => i.id)).toContain(11);
    expect(bw.running.map((s) => s.id)).toEqual([12]);

    // Disjoint partition: every non-closed slice is in exactly one of needsYou/running.
    const needsYouIds = new Set(bw.needsYou.map((i) => i.id));
    for (const s of bw.running) expect(needsYouIds.has(s.id)).toBe(false);
    expect(
      bw.done.length +
        bw.running.length +
        bw.slices.filter((s) => !s.closed && needsYouIds.has(s.id)).length,
    ).toBe(3);
  });

  test("a closed bookend slice is DONE, never NEEDS YOU", () => {
    const s = makeSlice({ id: 10, title: "Old accept", role: "needs-acceptance", closed: true });
    const [bw] = buildBoardSnapshot({
      worlds: [makeWorld(1, [s])],
      heartbeat: null,
      liveness: "dead",
      now,
    }).worlds;
    if (!bw) throw new Error("expected one board world");
    expect(bw.done.map((x) => x.id)).toEqual([10]);
    expect(bw.needsYou).toEqual([]);
    expect(bw.running).toEqual([]);
  });

  test("a needs-plan-review track surfaces the parent as a NEEDS YOU item", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent" });
    const world = makeWorld(7, [s], "needs-plan-review");
    const [bw] = buildBoardSnapshot({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
    }).worlds;
    if (!bw) throw new Error("expected one board world");
    expect(bw.needsYou.some((i) => i.id === 7 && i.reason === "plan-gate escalation")).toBe(true);
  });

  test("stamps each world with the supplied repo (multi-repo-shaped)", () => {
    const world = makeWorld(1, [makeSlice({ id: 10, title: "Work" })]);
    const snap = buildBoardSnapshot({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
      repo: "CaribouJohn/pi-flow",
    });
    expect(snap.worlds[0]?.repo).toBe("CaribouJohn/pi-flow");
  });

  test("defaults repo to empty string and lookupWarnings to []", () => {
    const world = makeWorld(1, [makeSlice({ id: 10, title: "Work" })]);
    const snap = buildBoardSnapshot({ worlds: [world], heartbeat: null, liveness: "dead", now });
    expect(snap.worlds[0]?.repo).toBe("");
    expect(snap.lookupWarnings).toEqual([]);
  });

  test("passes lookupWarnings through", () => {
    const snap = buildBoardSnapshot({
      worlds: [],
      heartbeat: null,
      liveness: "dead",
      now,
      lookupWarnings: ["warning: boom"],
    });
    expect(snap.lookupWarnings).toEqual(["warning: boom"]);
  });
});
