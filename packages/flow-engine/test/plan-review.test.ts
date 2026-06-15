import { describe, expect, test } from "bun:test";
import type { PlanReviewVerdict, World } from "../src/index.ts";
import { combineVerdict, detectEffortHigh, runPlanGate } from "../src/index.ts";
import { makeFakeFlow } from "./fakes.ts";

const OPTS = { reviewerIterationCap: 2, actor: "flow-bot", aiDisclaimer: "[ai]" };

// ── Schema smoke ────────────────────────────────────────────────────────────

describe("PlanReviewVerdict schema", () => {
  test("accepts a CLEAR verdict with agent-ready checks", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: [],
      childAgentReady: {
        10: { pass: true },
        11: { pass: true, reason: "meets bar" },
      },
    };
    expect(v.decision).toBe("CLEAR");
  });

  test("accepts an ESCALATE verdict with named risks", () => {
    const v: PlanReviewVerdict = {
      decision: "ESCALATE",
      risks: ["ADR conflict: T12 rewrites ADR-0016"],
      childAgentReady: { 10: { pass: false, reason: "no verification method" } },
    };
    expect(v.decision).toBe("ESCALATE");
    expect(v.risks).toEqual(["ADR conflict: T12 rewrites ADR-0016"]);
  });
});

// ── Deterministic effort:high detection ─────────────────────────────────────

describe("detectEffortHigh", () => {
  function world(...efforts: ("low" | "medium" | "high" | undefined)[]): World {
    return {
      track: { id: 1, branch: "track/test", role: "needs-plan-review" },
      slices: efforts.map((e, i) => ({
        id: 10 + i,
        title: `slice-${10 + i}`,
        role: "ready-for-agent" as const,
        review: "agent" as const,
        dependsOn: [] as number[],
        assignee: null,
        closed: false,
        branch: null,
        pr: null,
        effort: e,
      })),
    };
  }

  test("returns empty when no high-effort slices", () => {
    expect(detectEffortHigh(world("low", "medium"))).toEqual([]);
  });

  test("returns empty when effort is undefined", () => {
    expect(detectEffortHigh(world(undefined, "low"))).toEqual([]);
  });

  test("returns IDs of all high-effort slices", () => {
    expect(detectEffortHigh(world("low", "high", "medium", "high"))).toEqual([11, 13]);
  });

  test("only high triggers, not low or medium", () => {
    expect(detectEffortHigh(world("low", "medium", "low"))).toEqual([]);
  });

  test("handles an empty world", () => {
    expect(detectEffortHigh({ ...world(), slices: [] })).toEqual([]);
  });
});

// ── Combine logic ───────────────────────────────────────────────────────────

describe("combineVerdict", () => {
  function world(...efforts: ("low" | "medium" | "high" | undefined)[]): World {
    return {
      track: { id: 1, branch: "track/test", role: "needs-plan-review" },
      slices: efforts.map((e, i) => ({
        id: 10 + i,
        title: `slice-${10 + i}`,
        role: "ready-for-agent" as const,
        review: "agent" as const,
        dependsOn: [] as number[],
        assignee: null,
        closed: false,
        branch: null,
        pr: null,
        effort: e,
      })),
    };
  }

  /** Assert escalation and return the risks array for further inspection. */
  function assertEscalate(result: string[] | null): string[] {
    expect(result).not.toBeNull();
    return result as string[];
  }

  const clearVerdict: PlanReviewVerdict = {
    decision: "CLEAR",
    risks: [],
    childAgentReady: {
      10: { pass: true },
      11: { pass: true },
    },
  };

  test("clears when no smells and agent says CLEAR", () => {
    expect(combineVerdict(world("low", "medium"), clearVerdict)).toBeNull();
  });

  test("clears when world has one slice and it passes agent-ready", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: [],
      childAgentReady: { 10: { pass: true } },
    };
    expect(combineVerdict(world("low"), v)).toBeNull();
  });

  // ── Fail-safe: absent/empty verdict ──

  test("escalates when verdict is null (absent)", () => {
    const risks = assertEscalate(combineVerdict(world("low"), null));
    expect(risks).toContain("Plan review agent returned no verdict");
  });

  test("escalates with agent error message when agentError is provided", () => {
    const risks = assertEscalate(
      combineVerdict(world("low"), null, new Error("model unavailable")),
    );
    expect(risks).toContain("plan-review agent failed: model unavailable");
    // The generic fallback is NOT used when an error is present.
    expect(risks).not.toContain("Plan review agent returned no verdict");
  });

  test("escalates when verdict has no childAgentReady entries", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: [],
      childAgentReady: {},
    };
    const risks = assertEscalate(combineVerdict(world("low", "medium"), v));
    expect(risks.some((r) => r.includes("no agent-ready check"))).toBe(true);
  });

  // ── Deterministic: effort:high ──

  test("escalates on effort:high even when agent says CLEAR", () => {
    const risks = assertEscalate(combineVerdict(world("low", "high"), clearVerdict));
    expect(risks.some((r) => r.includes("effort:high"))).toBe(true);
  });

  test("effort:high risk names the specific slice IDs", () => {
    const risks = assertEscalate(combineVerdict(world("high", "low"), clearVerdict));
    expect(risks.some((r) => r.includes("10") && r.includes("effort:high"))).toBe(true);
  });

  // ── Agent ESCALATE ──

  test("escalates when agent verdict is ESCALATE", () => {
    const v: PlanReviewVerdict = {
      decision: "ESCALATE",
      risks: ["security surface exposed"],
      childAgentReady: { 10: { pass: true } },
    };
    const risks = assertEscalate(combineVerdict(world("low"), v));
    expect(risks).toContain("security surface exposed");
  });

  test("ESCALATE without explicit risks still escalates", () => {
    const v: PlanReviewVerdict = {
      decision: "ESCALATE",
      risks: [],
      childAgentReady: { 10: { pass: true } },
    };
    const risks = assertEscalate(combineVerdict(world("low"), v));
    expect(risks.some((r) => r.includes("without naming specific risks"))).toBe(true);
  });

  // ── Agent risks under CLEAR ──

  test("escalates when agent says CLEAR but has named risks", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: ["irreversible migration detected"],
      childAgentReady: { 10: { pass: true } },
    };
    const risks = assertEscalate(combineVerdict(world("low"), v));
    expect(risks).toContain("irreversible migration detected");
  });

  // ── Per-child agent-ready failures ──

  test("escalates when a child fails agent-ready", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: [],
      childAgentReady: {
        10: { pass: false, reason: "no verification method" },
        11: { pass: true },
      },
    };
    const risks = assertEscalate(combineVerdict(world("low", "medium"), v));
    expect(risks.some((r) => r.includes("10") && r.includes("no verification method"))).toBe(true);
  });

  test("escalates when a child is missing from agent-ready entirely", () => {
    const v: PlanReviewVerdict = {
      decision: "CLEAR",
      risks: [],
      childAgentReady: { 10: { pass: true } },
    };
    const risks = assertEscalate(combineVerdict(world("low", "low"), v));
    expect(risks.some((r) => r.includes("11") && r.includes("no agent-ready check"))).toBe(true);
  });

  // ── Multiple smells aggregate ──

  test("aggregates multiple escalation sources", () => {
    const v: PlanReviewVerdict = {
      decision: "ESCALATE",
      risks: ["ADR conflict"],
      childAgentReady: { 10: { pass: false, reason: "unclear scope" }, 11: { pass: true } },
    };
    const risks = assertEscalate(combineVerdict(world("high", "low"), v));
    expect(risks.length).toBeGreaterThanOrEqual(3);
    expect(risks.some((r) => r.includes("effort:high"))).toBe(true);
    expect(risks.some((r) => r.includes("ADR conflict"))).toBe(true);
    expect(risks.some((r) => r.includes("10") && r.includes("unclear scope"))).toBe(true);
  });
});

// ── Gate runner: clear path (T13) ───────────────────────────────────────────

describe("runPlanGate — clear path (T13)", () => {
  test("advances parent to tracking and creates the track branch", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/my-feature",
      slices: [
        { id: 10, effort: "low" },
        { id: 11, effort: "medium" },
      ],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true }, 11: { pass: true } },
      },
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("clear");
    expect(flow.track.role).toBe("tracking");
    expect(flow.counts.createTrackBranch).toEqual(["track/my-feature"]);
    expect(flow.counts.roleChanges).toEqual([{ id: 1, role: "tracking" }]);
  });

  test("posts a clearance marker comment with the track branch name", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/my-feature",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS);

    const clearance = flow.comments.find((c) => c.body.includes("[plan-gate] Plan review cleared"));
    expect(clearance).toBeDefined();
    expect((clearance as NonNullable<typeof clearance>).body).toContain("track/my-feature");
    expect((clearance as NonNullable<typeof clearance>).body).toContain("created off `main`");
    expect((clearance as NonNullable<typeof clearance>).body.startsWith("[ai]")).toBe(true);
  });

  test("includes the cost estimate in the clearance comment when provided", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS, "≈ $0.42, 1 slice");

    const clearance = flow.comments.find((c) => c.body.includes("[plan-gate]"));
    expect(clearance).toBeDefined();
    expect((clearance as NonNullable<typeof clearance>).body).toContain("≈ $0.42, 1 slice");
  });

  test("does not call planReview when role is past needs-plan-review (idempotent)", async () => {
    const flow = makeFakeFlow({
      trackRole: "tracking",
      trackBranch: "track/existing",
      slices: [{ id: 10 }],
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("clear");
    expect(flow.counts.planReview).toEqual([]);
    expect(flow.counts.createTrackBranch).toEqual([]);
    expect(flow.counts.roleChanges).toEqual([]);
  });
});

// ── Gate runner: escalate path (T14) ────────────────────────────────────────

describe("runPlanGate — escalate path (T14)", () => {
  test("escalates when the agent verdict is ESCALATE", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "ESCALATE",
        risks: ["irreversible migration: schema change drops a column"],
        childAgentReady: { 10: { pass: true } },
      },
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("escalate");
    expect(result.risks).toContain("irreversible migration: schema change drops a column");
    expect(flow.track.role).toBe("needs-plan-review");
    expect(flow.counts.roleChanges).toEqual([]);
    expect(flow.counts.createTrackBranch).toEqual([]);
  });

  test("escalates on deterministic effort:high", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "high" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("escalate");
    expect(result.risks.some((r) => r.includes("effort:high"))).toBe(true);
    expect(flow.track.role).toBe("needs-plan-review");
  });

  test("escalates when an agent-ready child fails", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: false, reason: "no verification method" } },
      },
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("escalate");
    expect(result.risks.some((r) => r.includes("10") && r.includes("no verification method"))).toBe(
      true,
    );
  });

  test("escalates when planReview agent is missing (no verdict configured)", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    // The fake throws when no verdict is configured; the error must be surfaced.
    expect(result.kind).toBe("escalate");
    expect(result.risks.some((r) => r.startsWith("plan-review agent failed:"))).toBe(true);
    expect(flow.track.role).toBe("needs-plan-review");
  });

  test("escalates when planReview agent throws an error", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewError: new Error("model unavailable"),
    });

    const result = await runPlanGate(flow.ports, 1, OPTS);

    expect(result.kind).toBe("escalate");
    // Error message must be surfaced — not the generic "no verdict" fallback.
    expect(result.risks).toContain("plan-review agent failed: model unavailable");
    expect(result.risks).not.toContain("Plan review agent returned no verdict");
  });

  test("posts an escalation marker comment with the named risks", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "high" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS);

    const escalation = flow.comments.find((c) =>
      c.body.includes("[plan-gate] Plan review escalated"),
    );
    expect(escalation).toBeDefined();
    const esc = escalation as NonNullable<typeof escalation>;
    expect(esc.body).toContain("effort:high");
    expect(esc.body).toContain("**Risk:**");
    expect(esc.body.startsWith("[ai]")).toBe(true);
  });
});

// ── Marker comment semantics ─────────────────────────────────────────────────

describe("plan-gate marker comments", () => {
  test("clearance marker is prefixed [plan-gate] with AI disclaimer", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS);

    const marker = flow.comments.find((c) => c.body.includes("[plan-gate]"));
    expect(marker).toBeDefined();
    expect((marker as NonNullable<typeof marker>).body).toMatch(/^\[ai\]/);
  });

  test("escalation marker is prefixed [plan-gate] with AI disclaimer", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "high" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS);

    const marker = flow.comments.find((c) => c.body.includes("[plan-gate]"));
    expect(marker).toBeDefined();
    const m = marker as NonNullable<typeof marker>;
    expect(m.body).toMatch(/^\[ai\]/);
    expect(m.body).toContain("escalated");
  });

  test("idempotent: a second run over a cleared gate posts no duplicate comments", async () => {
    const flow = makeFakeFlow({
      trackRole: "tracking",
      trackBranch: "track/x",
      slices: [{ id: 10 }],
    });

    const before = flow.comments.length;
    await runPlanGate(flow.ports, 1, OPTS);
    expect(flow.comments.length).toBe(before);
  });
});

// ── Counter checks ──────────────────────────────────────────────────────────

describe("plan-gate counter observability", () => {
  test("calls planReview agent exactly once on a fresh plan-review gate", async () => {
    const flow = makeFakeFlow({
      trackRole: "needs-plan-review",
      trackBranch: "track/x",
      slices: [{ id: 10, effort: "low" }],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: { 10: { pass: true } },
      },
    });

    await runPlanGate(flow.ports, 1, OPTS);

    expect(flow.counts.planReview).toEqual([1]);
  });
});
