import { describe, expect, test } from "bun:test";
import type { FlowdConfig } from "../src/config.ts";
import { assertWorkdirIsolated, buildPorts, makeVerifyGate } from "../src/flow-run.ts";
import { makeCredentials } from "./helpers.ts";

describe("assertWorkdirIsolated (leak guard)", () => {
  test("rejects a workdir nested inside the repo", () => {
    expect(() => assertWorkdirIsolated("/repo/.flowd-workdir", "/repo")).toThrow(
      /OUTSIDE the operated repo/,
    );
  });
  test("rejects the repo root itself", () => {
    expect(() => assertWorkdirIsolated("/repo", "/repo")).toThrow(/inside the repo/);
  });
  test("accepts a workdir outside the repo", () => {
    expect(() => assertWorkdirIsolated("/work/flowd", "/repo")).not.toThrow();
  });
  test("accepts a sibling sharing a name prefix (not a real ancestor)", () => {
    expect(() => assertWorkdirIsolated("/repo-sandbox", "/repo")).not.toThrow();
  });
});

describe("makeVerifyGate", () => {
  test("green when the command exits 0", async () => {
    const gate = makeVerifyGate("/wd", "whatever", async () => ({ exitCode: 0, output: "" }));
    expect(await gate.run(1)).toEqual({ green: true });
  });
  test("red when the command exits non-zero", async () => {
    const gate = makeVerifyGate("/wd", "whatever", async () => ({ exitCode: 1, output: "" }));
    expect(await gate.run(1)).toEqual({ green: false, output: "(no output)" });
  });
  test("red gate surfaces command output in the result", async () => {
    const gate = makeVerifyGate("/wd", "bun run verify", async () => ({
      exitCode: 1,
      output: "error TS2345: Argument of type 'string' is not assignable",
    }));
    const result = await gate.run(1);
    expect(result.green).toBe(false);
    expect(result.output).toContain("TS2345");
  });
  test("green gate does not include output", async () => {
    const gate = makeVerifyGate("/wd", "bun run verify", async () => ({
      exitCode: 0,
      output: "All tests passed",
    }));
    const result = await gate.run(1);
    expect(result).toEqual({ green: true });
    expect(result.output).toBeUndefined();
  });
  test("output is capped to 4000 chars when very long", async () => {
    const longOutput = "x".repeat(5000);
    const gate = makeVerifyGate("/wd", "whatever", async () => ({
      exitCode: 1,
      output: longOutput,
    }));
    const result = await gate.run(1);
    expect(result.green).toBe(false);
    expect(result.output?.length).toBeLessThanOrEqual(4001); // cap + leading ellipsis char
  });
  test("runs the configured command in the workdir", async () => {
    let seen: { cmd: string; cwd: string } | undefined;
    const gate = makeVerifyGate("/wd", "bun run verify", async (cmd, cwd) => {
      seen = { cmd, cwd };
      return { exitCode: 0, output: "" };
    });
    await gate.run(1);
    expect(seen).toEqual({ cmd: "bun run verify", cwd: "/wd" });
  });
});

describe("buildPorts", () => {
  const config: FlowdConfig = {
    repo: "o/r",
    defaultBranch: "main",
    trackBranch: "track/x",
    workdir: "/wd",
    actor: "flow-bot",
    aiDisclaimer: "[ai]",
    reviewerIterationCap: 2,
    verifyCommand: "bun run verify",
    credentialsPath: "/c.json",
    models: {
      implement: { provider: "anthropic", id: "claude-opus-4-8" },
      review: { provider: "openai", id: "gpt-5" },
      slice: { provider: "anthropic", id: "claude-opus-4-8" },
      planReview: { provider: "openai", id: "gpt-5" },
    },
    costEstimator: {
      reworkMultiplier: 1.3,
      effortTokens: {
        low: { implement: 1000, review: 500 },
        medium: { implement: 3000, review: 1500 },
        high: { implement: 10000, review: 4000 },
      },
      modelPrices: {
        cheap: 3.0,
        mid: 10.0,
        strong: 50.0,
      },
      effortToModel: {
        low: { implement: "cheap", review: "strong" },
        medium: { implement: "mid", review: "strong" },
        high: { implement: "strong", review: "strong" },
      },
    },
  };

  test("composes all four engine ports", () => {
    const ports = buildPorts(config, makeCredentials({}), "ghp_fake_test_token", "track/5");
    expect(typeof ports.tracker.listSlices).toBe("function");
    expect(typeof ports.forge.driftRefresh).toBe("function");
    expect(typeof ports.agent.implement).toBe("function");
    expect(typeof ports.agent.review).toBe("function");
    expect(typeof ports.agent.planReview).toBe("function");
    expect(typeof ports.verify.run).toBe("function");
  });
});

import type { TrackerSlice } from "@pi-flow/flow-engine";
import {
  type ListingTracker,
  listAcceptReady,
  listNeedsPlanReviewWithPrd,
  listNeedsSlicingWithPrd,
  parsePrdPath,
  resolveTrackBranch,
} from "../src/flow-run.ts";

// ── resolveTrackBranch ──────────────────────────────────────────────────────

describe("resolveTrackBranch", () => {
  function makeBodyTracker(body: string) {
    return { getItemBody: async (_id: number) => body };
  }

  test("returns Track-branch marker when present in body", async () => {
    const tracker = makeBodyTracker(
      "PRD: docs/foo.md\nTrack-branch: track/0005-continuous-daemon\n",
    );
    expect(await resolveTrackBranch(106, tracker, "track/fallback")).toBe(
      "track/0005-continuous-daemon",
    );
  });

  test("returns fallback when Track-branch marker is absent", async () => {
    const tracker = makeBodyTracker("PRD: docs/foo.md\n");
    expect(await resolveTrackBranch(106, tracker, "track/0005-continuous-daemon")).toBe(
      "track/0005-continuous-daemon",
    );
  });

  test("trims whitespace from marker value", async () => {
    const tracker = makeBodyTracker("Track-branch:  track/spaced  \n");
    expect(await resolveTrackBranch(1, tracker, "track/fallback")).toBe("track/spaced");
  });

  test("returns fallback when body is empty", async () => {
    const tracker = makeBodyTracker("");
    expect(await resolveTrackBranch(1, tracker, "track/config-branch")).toBe("track/config-branch");
  });

  test("passes the given trackId to getItemBody", async () => {
    let seenId: number | undefined;
    const tracker = {
      getItemBody: async (id: number) => {
        seenId = id;
        return "";
      },
    };
    await resolveTrackBranch(42, tracker, "track/x");
    expect(seenId).toBe(42);
  });
});

describe("parsePrdPath", () => {
  test("extracts path from PRD: line", () => {
    expect(parsePrdPath("PRD: docs/prd/0005-foo.md\nsome other content")).toBe(
      "docs/prd/0005-foo.md",
    );
  });

  test("trims leading/trailing whitespace from value", () => {
    expect(parsePrdPath("PRD:  docs/prd/0005-foo.md  ")).toBe("docs/prd/0005-foo.md");
  });

  test("returns null when no PRD: line exists", () => {
    expect(parsePrdPath("This issue has no PRD marker.\n## Details\nsome text")).toBeNull();
  });

  test("returns null for empty body", () => {
    expect(parsePrdPath("")).toBeNull();
  });

  test("is case-sensitive — lowercase prd: is not matched", () => {
    expect(parsePrdPath("prd: docs/prd/0005-foo.md")).toBeNull();
  });

  test("matches first PRD: line when multiple exist", () => {
    expect(parsePrdPath("PRD: docs/prd/first.md\nPRD: docs/prd/second.md")).toBe(
      "docs/prd/first.md",
    );
  });
});

// ── fake tracker factory ──────────────────────────────────────────────────────

/** Build a minimal fake ListingTracker. */
function makeFakeTracker(options: {
  byRole?: Record<string, number[]>;
  bodies?: Record<number, string>;
  slices?: Record<number, TrackerSlice[]>;
}): ListingTracker {
  return {
    async listByRole(role) {
      return options.byRole?.[role] ?? [];
    },
    async getItemBody(id) {
      return options.bodies?.[id] ?? "";
    },
    async listSlices(id) {
      return options.slices?.[id] ?? [];
    },
  };
}

// ── listNeedsSlicingWithPrd ───────────────────────────────────────────────────

describe("listNeedsSlicingWithPrd", () => {
  const FAKE_CONFIG = {} as Parameters<typeof listNeedsSlicingWithPrd>[0];

  test("returns items whose body contains a PRD: marker", async () => {
    const tracker = makeFakeTracker({
      byRole: { "needs-slicing": [10, 11] },
      bodies: {
        10: "PRD: docs/prd/0010-foo.md\nsome body",
        11: "PRD: docs/prd/0011-bar.md",
      },
    });
    const result = await listNeedsSlicingWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([
      { id: 10, prdPath: "docs/prd/0010-foo.md" },
      { id: 11, prdPath: "docs/prd/0011-bar.md" },
    ]);
  });

  test("excludes items whose body has no PRD: marker", async () => {
    const tracker = makeFakeTracker({
      byRole: { "needs-slicing": [10, 11] },
      bodies: {
        10: "PRD: docs/prd/0010-foo.md",
        11: "no marker here",
      },
    });
    const result = await listNeedsSlicingWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([{ id: 10, prdPath: "docs/prd/0010-foo.md" }]);
  });

  test("returns empty array when listByRole returns no items", async () => {
    const tracker = makeFakeTracker({ byRole: { "needs-slicing": [] } });
    const result = await listNeedsSlicingWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([]);
  });

  test("returns empty array when no item has a PRD: marker", async () => {
    const tracker = makeFakeTracker({
      byRole: { "needs-slicing": [5] },
      bodies: { 5: "nothing useful" },
    });
    const result = await listNeedsSlicingWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([]);
  });

  test("passes 'needs-slicing' as the role to listByRole", async () => {
    const seenRoles: string[] = [];
    const tracker: ListingTracker = {
      async listByRole(role) {
        seenRoles.push(role);
        return [];
      },
      async getItemBody() {
        return "";
      },
      async listSlices() {
        return [];
      },
    };
    await listNeedsSlicingWithPrd(FAKE_CONFIG, tracker);
    expect(seenRoles).toEqual(["needs-slicing"]);
  });
});

// ── listNeedsPlanReviewWithPrd ────────────────────────────────────────────────

describe("listNeedsPlanReviewWithPrd", () => {
  const FAKE_CONFIG = {} as Parameters<typeof listNeedsPlanReviewWithPrd>[0];

  test("returns items whose body contains a PRD: marker", async () => {
    const tracker = makeFakeTracker({
      byRole: { "needs-plan-review": [20, 21] },
      bodies: {
        20: "PRD: docs/prd/0020-qux.md",
        21: "PRD: docs/prd/0021-quux.md",
      },
    });
    const result = await listNeedsPlanReviewWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([
      { id: 20, prdPath: "docs/prd/0020-qux.md" },
      { id: 21, prdPath: "docs/prd/0021-quux.md" },
    ]);
  });

  test("excludes items without a PRD: marker", async () => {
    const tracker = makeFakeTracker({
      byRole: { "needs-plan-review": [20, 21] },
      bodies: {
        20: "PRD: docs/prd/0020-qux.md",
        21: "no marker",
      },
    });
    const result = await listNeedsPlanReviewWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([{ id: 20, prdPath: "docs/prd/0020-qux.md" }]);
  });

  test("returns empty array when listByRole returns no items", async () => {
    const tracker = makeFakeTracker({ byRole: { "needs-plan-review": [] } });
    const result = await listNeedsPlanReviewWithPrd(FAKE_CONFIG, tracker);
    expect(result).toEqual([]);
  });

  test("passes 'needs-plan-review' as the role to listByRole", async () => {
    const seenRoles: string[] = [];
    const tracker: ListingTracker = {
      async listByRole(role) {
        seenRoles.push(role);
        return [];
      },
      async getItemBody() {
        return "";
      },
      async listSlices() {
        return [];
      },
    };
    await listNeedsPlanReviewWithPrd(FAKE_CONFIG, tracker);
    expect(seenRoles).toEqual(["needs-plan-review"]);
  });
});

// ── listAcceptReady ───────────────────────────────────────────────────────────

function makeSlice(overrides: Partial<TrackerSlice> & { id: number }): TrackerSlice {
  return {
    title: `Slice #${overrides.id}`,
    role: "ready-for-agent",
    review: "agent",
    dependsOn: [],
    assignee: null,
    closed: false,
    ...overrides,
  };
}

describe("listAcceptReady", () => {
  const FAKE_CONFIG = {} as Parameters<typeof listAcceptReady>[0];

  test("returns tracking parent when all non-acceptance slices are closed", async () => {
    const tracker = makeFakeTracker({
      byRole: { tracking: [30] },
      slices: {
        30: [
          makeSlice({ id: 100, role: "ready-for-agent", closed: true }),
          makeSlice({ id: 101, role: "ready-for-agent", closed: true }),
        ],
      },
    });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([30]);
  });

  test("excludes tracking parent when any non-acceptance slice is still open", async () => {
    const tracker = makeFakeTracker({
      byRole: { tracking: [30] },
      slices: {
        30: [
          makeSlice({ id: 100, role: "ready-for-agent", closed: true }),
          makeSlice({ id: 101, role: "ready-for-agent", closed: false }), // still open
        ],
      },
    });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([]);
  });

  test("ignores needs-acceptance slices when deciding readiness", async () => {
    const tracker = makeFakeTracker({
      byRole: { tracking: [30] },
      slices: {
        30: [
          makeSlice({ id: 100, role: "ready-for-agent", closed: true }),
          // needs-acceptance slice is still open — must not block accept-stage
          makeSlice({ id: 102, role: "needs-acceptance", closed: false }),
        ],
      },
    });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([30]);
  });

  test("returns empty array when no tracking parent exists", async () => {
    const tracker = makeFakeTracker({ byRole: { tracking: [] } });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([]);
  });

  test("returns empty array when tracking parent has no slices", async () => {
    const tracker = makeFakeTracker({
      byRole: { tracking: [30] },
      slices: { 30: [] },
    });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([30]); // vacuously true: every() on empty is true
  });

  test("correctly identifies multiple parents — ready and not-ready mixed", async () => {
    const tracker = makeFakeTracker({
      byRole: { tracking: [30, 31, 32] },
      slices: {
        30: [makeSlice({ id: 100, role: "ready-for-agent", closed: true })], // ready
        31: [makeSlice({ id: 110, role: "ready-for-agent", closed: false })], // not ready
        32: [makeSlice({ id: 120, role: "ready-for-agent", closed: true })], // ready
      },
    });
    const result = await listAcceptReady(FAKE_CONFIG, tracker);
    expect(result).toEqual([30, 32]);
  });

  test("passes 'tracking' as the role to listByRole", async () => {
    const seenRoles: string[] = [];
    const tracker: ListingTracker = {
      async listByRole(role) {
        seenRoles.push(role);
        return [];
      },
      async getItemBody() {
        return "";
      },
      async listSlices() {
        return [];
      },
    };
    await listAcceptReady(FAKE_CONFIG, tracker);
    expect(seenRoles).toEqual(["tracking"]);
  });
});
