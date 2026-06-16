import { describe, expect, test } from "bun:test";
import type { Slice, World } from "@pi-flow/flow-engine";
import {
  DEFAULT_POLL_CADENCE_MS,
  type DaemonHeartbeat,
  computeLiveness,
  formatStatus,
  sliceDerivedState,
} from "../src/status.ts";

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

function makeWorld(trackId: number, slices: Slice[]): World {
  return {
    track: { id: trackId, branch: `track/${trackId}`, role: "tracking" },
    slices,
  };
}

function makeHeartbeat(overrides?: Partial<DaemonHeartbeat>): DaemonHeartbeat {
  return {
    lastTickAt: new Date().toISOString(),
    activity: "claimed #10",
    consecutiveErrors: 0,
    pid: 1234,
    ...overrides,
  };
}

const CADENCE = DEFAULT_POLL_CADENCE_MS; // 60 000 ms

// ── computeLiveness ────────────────────────────────────────────────────────────

describe("computeLiveness", () => {
  test("returns dead when heartbeat is null", () => {
    expect(computeLiveness(null, Date.now())).toBe("dead");
  });

  test("returns alive when age is within 2× cadence", () => {
    const now = Date.now();
    const hb = makeHeartbeat({ lastTickAt: new Date(now - CADENCE).toISOString() });
    expect(computeLiveness(hb, now)).toBe("alive");
  });

  test("returns alive when age is exactly 2× cadence", () => {
    const now = Date.now();
    const hb = makeHeartbeat({ lastTickAt: new Date(now - 2 * CADENCE).toISOString() });
    expect(computeLiveness(hb, now)).toBe("alive");
  });

  test("returns stale when age is between 2× and 10× cadence", () => {
    const now = Date.now();
    const hb = makeHeartbeat({ lastTickAt: new Date(now - 3 * CADENCE).toISOString() });
    expect(computeLiveness(hb, now)).toBe("stale");
  });

  test("returns stale when age is exactly 10× cadence", () => {
    const now = Date.now();
    const hb = makeHeartbeat({ lastTickAt: new Date(now - 10 * CADENCE).toISOString() });
    expect(computeLiveness(hb, now)).toBe("stale");
  });

  test("returns dead when age exceeds 10× cadence", () => {
    const now = Date.now();
    const hb = makeHeartbeat({ lastTickAt: new Date(now - 11 * CADENCE).toISOString() });
    expect(computeLiveness(hb, now)).toBe("dead");
  });

  test("respects a custom poll cadence", () => {
    const cadence = 10_000; // 10 s
    const now = Date.now();
    // 15 s ago — within 2× of 10 s cadence → alive
    const hbAlive = makeHeartbeat({ lastTickAt: new Date(now - 15_000).toISOString() });
    expect(computeLiveness(hbAlive, now, cadence)).toBe("alive");

    // 25 s ago — between 2× and 10× → stale
    const hbStale = makeHeartbeat({ lastTickAt: new Date(now - 25_000).toISOString() });
    expect(computeLiveness(hbStale, now, cadence)).toBe("stale");

    // 110 s ago — beyond 10× → dead
    const hbDead = makeHeartbeat({ lastTickAt: new Date(now - 110_000).toISOString() });
    expect(computeLiveness(hbDead, now, cadence)).toBe("dead");
  });
});

// ── sliceDerivedState ──────────────────────────────────────────────────────────

describe("sliceDerivedState", () => {
  test("closed slice → done", () => {
    const world = makeWorld(1, []);
    const s = makeSlice({ id: 10, title: "x", closed: true });
    expect(sliceDerivedState(s, { ...world, slices: [s] })).toBe("done");
  });

  test("ready-for-human → needs-you", () => {
    const s = makeSlice({ id: 10, title: "x", role: "ready-for-human" });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("needs-you");
  });

  test("needs-acceptance → needs-you", () => {
    const s = makeSlice({ id: 10, title: "x", role: "needs-acceptance" });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("needs-you");
  });

  test("in-progress with approved PR → reviewed", () => {
    const s = makeSlice({
      id: 10,
      title: "x",
      assignee: "bot",
      pr: { number: 99, base: "track/1", status: "approved", reviewAttempts: 1 },
    });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("reviewed");
  });

  test("in-progress with open PR → in-review", () => {
    const s = makeSlice({
      id: 10,
      title: "x",
      assignee: "bot",
      pr: { number: 99, base: "track/1", status: "open", reviewAttempts: 0 },
    });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("in-review");
  });

  test("in-progress with no PR → in-progress", () => {
    const s = makeSlice({ id: 10, title: "x", assignee: "bot" });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("in-progress");
  });

  test("blocked by open dep → blocked", () => {
    const dep = makeSlice({ id: 9, title: "dep" }); // open
    const s = makeSlice({ id: 10, title: "x", dependsOn: [9] });
    const world = makeWorld(1, [dep, s]);
    expect(sliceDerivedState(s, world)).toBe("blocked");
  });

  test("assignable (ready-for-agent, unblocked, no assignee) → ready", () => {
    const s = makeSlice({ id: 10, title: "x", role: "ready-for-agent" });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("ready");
  });

  test("other role falls through to role label", () => {
    const s = makeSlice({ id: 10, title: "x", role: "needs-triage" });
    const world = makeWorld(1, [s]);
    expect(sliceDerivedState(s, world)).toBe("needs-triage");
  });
});

// ── formatStatus ───────────────────────────────────────────────────────────────

describe("formatStatus — daemon line", () => {
  const now = Date.now();

  test("absent heartbeat → daemon: absent", () => {
    const out = formatStatus({ worlds: [], heartbeat: null, liveness: "dead", now });
    expect(out).toContain("daemon: absent");
  });

  test("alive heartbeat → shows pid and last-tick age", () => {
    const hb = makeHeartbeat({
      pid: 4242,
      activity: "merged #7",
      lastTickAt: new Date(now - 30_000).toISOString(),
    });
    const out = formatStatus({ worlds: [], heartbeat: hb, liveness: "alive", now });
    expect(out).toContain("daemon: alive");
    expect(out).toContain("pid=4242");
    expect(out).toContain('"merged #7"');
    expect(out).toContain("30s ago");
  });

  test("stale heartbeat → shows stale warning", () => {
    const hb = makeHeartbeat({ lastTickAt: new Date(now - 5 * CADENCE).toISOString() });
    const out = formatStatus({ worlds: [], heartbeat: hb, liveness: "stale", now });
    expect(out).toContain("daemon: stale");
    expect(out).toContain("may be stuck");
  });

  test("dead liveness with non-null heartbeat → shows dead with last-tick age (crashed)", () => {
    const hb = makeHeartbeat({
      pid: 9999,
      lastTickAt: new Date(now - 15 * CADENCE).toISOString(),
    });
    const out = formatStatus({ worlds: [], heartbeat: hb, liveness: "dead", now });
    expect(out).toContain("daemon: dead");
    expect(out).toContain("ago");
    expect(out).toContain("process may have crashed");
    // Must NOT report absent — the file exists, daemon did run
    expect(out).not.toContain("absent");
  });
});

describe("formatStatus — empty world", () => {
  const now = Date.now();

  test("no tracking parents → reports none found and NEEDS YOU: 0", () => {
    const out = formatStatus({ worlds: [], heartbeat: null, liveness: "dead", now });
    expect(out).toContain("no tracking parents found");
    expect(out).toContain("NEEDS YOU: 0");
  });
});

describe("formatStatus — single track", () => {
  const now = Date.now();

  test("shows track id, done/total, and slice states", () => {
    const s1 = makeSlice({ id: 10, title: "Add login", closed: true });
    const s2 = makeSlice({
      id: 11,
      title: "Add dashboard",
      role: "ready-for-agent",
      assignee: "bot",
    });
    const world = makeWorld(5, [s1, s2]);

    const out = formatStatus({ worlds: [world], heartbeat: null, liveness: "dead", now });

    expect(out).toContain("track #5");
    expect(out).toContain("1/2 done");
    expect(out).toContain("#10  Add login  [done]");
    expect(out).toContain("#11  Add dashboard  [in-progress]");
    expect(out).toContain("NEEDS YOU: 0");
  });

  test("NEEDS YOU count includes ready-for-human and needs-acceptance slices", () => {
    const s1 = makeSlice({ id: 10, title: "Review it", role: "ready-for-human" });
    const s2 = makeSlice({ id: 11, title: "Accept it", role: "needs-acceptance" });
    const s3 = makeSlice({ id: 12, title: "Agent work", role: "ready-for-agent" });
    const world = makeWorld(3, [s1, s2, s3]);

    const out = formatStatus({ worlds: [world], heartbeat: null, liveness: "dead", now });

    expect(out).toContain("[2 NEEDS YOU]");
    expect(out).toContain("NEEDS YOU: 2");
    expect(out).toContain("#10  Review it  [needs-you]");
    expect(out).toContain("#11  Accept it  [needs-you]");
  });

  test("closed needs-you slices do not count towards NEEDS YOU", () => {
    const s = makeSlice({ id: 10, title: "Done review", role: "ready-for-human", closed: true });
    const world = makeWorld(1, [s]);

    const out = formatStatus({ worlds: [world], heartbeat: null, liveness: "dead", now });

    expect(out).toContain("NEEDS YOU: 0");
    expect(out).toContain("[done]");
  });
});

describe("formatStatus — multiple tracks", () => {
  const now = Date.now();

  test("aggregates NEEDS YOU across all tracks", () => {
    const s1 = makeSlice({ id: 10, title: "Human review", role: "ready-for-human" });
    const world1 = makeWorld(5, [s1]);

    const s2 = makeSlice({ id: 20, title: "Acceptance", role: "needs-acceptance" });
    const world2 = makeWorld(6, [s2]);

    const out = formatStatus({ worlds: [world1, world2], heartbeat: null, liveness: "dead", now });

    expect(out).toContain("track #5");
    expect(out).toContain("track #6");
    expect(out).toContain("NEEDS YOU: 2");
  });

  test("track with no NEEDS YOU has no tag on the header", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent" });
    const world = makeWorld(7, [s]);

    const out = formatStatus({ worlds: [world], heartbeat: null, liveness: "dead", now });

    const trackLine = out.split("\n").find((l) => l.startsWith("track #7"));
    expect(trackLine).toBeDefined();
    expect(trackLine).not.toContain("NEEDS YOU");
  });
});

// ── formatStatus — lookup warnings ──────────────────────────────────────────────

describe("formatStatus — lookup warnings", () => {
  const now = Date.now();

  test("no lookupWarnings → no warning block in output", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent" });
    const world = makeWorld(1, [s]);
    const out = formatStatus({ worlds: [world], heartbeat: null, liveness: "dead", now });
    expect(out).not.toContain("warning:");
  });

  test("empty lookupWarnings array → no warning block in output", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent" });
    const world = makeWorld(1, [s]);
    const out = formatStatus({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
      lookupWarnings: [],
    });
    expect(out).not.toContain("warning:");
  });

  test("forge errors appear as warnings and incomplete-data notice is appended", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent", assignee: "bot" });
    const world = makeWorld(1, [s]);
    const out = formatStatus({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
      lookupWarnings: [
        "warning: branch lookup failed for #10: authentication required",
        "warning: PR lookup failed for #10: authentication required",
      ],
    });
    expect(out).toContain("warning: branch lookup failed for #10: authentication required");
    expect(out).toContain("warning: PR lookup failed for #10: authentication required");
    expect(out).toContain("some slice data may be incomplete");
  });

  test("warnings appear after the NEEDS YOU summary line", () => {
    const s = makeSlice({ id: 10, title: "Work", role: "ready-for-agent", assignee: "bot" });
    const world = makeWorld(1, [s]);
    const out = formatStatus({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
      lookupWarnings: ["warning: branch lookup failed for #10: connection refused"],
    });
    const needsYouIdx = out.indexOf("NEEDS YOU:");
    const warningIdx = out.indexOf("warning: branch lookup failed");
    expect(needsYouIdx).toBeGreaterThan(-1);
    expect(warningIdx).toBeGreaterThan(needsYouIdx);
  });

  test("multiple warnings from different slices are all surfaced", () => {
    const s1 = makeSlice({ id: 10, title: "Alpha", role: "ready-for-agent", assignee: "bot" });
    const s2 = makeSlice({ id: 11, title: "Beta", role: "ready-for-agent", assignee: "bot" });
    const world = makeWorld(1, [s1, s2]);
    const out = formatStatus({
      worlds: [world],
      heartbeat: null,
      liveness: "dead",
      now,
      lookupWarnings: [
        "warning: PR lookup failed for #10: network timeout",
        "warning: PR lookup failed for #11: network timeout",
      ],
    });
    expect(out).toContain("warning: PR lookup failed for #10: network timeout");
    expect(out).toContain("warning: PR lookup failed for #11: network timeout");
    expect(out).toContain("some slice data may be incomplete");
  });
});

// ── planInvocation — status verb ───────────────────────────────────────────────

describe("planInvocation — status", () => {
  // Import here to avoid a circular dependency on the cli module's test file.
  test("status with no flags", async () => {
    const { planInvocation } = await import("../src/cli.ts");
    expect(planInvocation(["status"])).toEqual({ kind: "status", config: undefined });
  });

  test("status with --config", async () => {
    const { planInvocation } = await import("../src/cli.ts");
    expect(planInvocation(["status", "--config", "c.json"])).toEqual({
      kind: "status",
      config: "c.json",
    });
  });
});
