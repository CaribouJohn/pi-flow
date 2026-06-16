import { describe, expect, test } from "bun:test";
import type { SlicePlan } from "@pi-flow/flow-engine";
import { makeFakeFlow } from "@pi-flow/flow-engine/test/fakes";
import type { FlowdConfig } from "../src/config.ts";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";
import { buildPlanPorts, planCostEstimate, runPlanPipeline } from "../src/flow-plan.ts";
import { makeCredentials } from "./helpers.ts";

const VALID_CONFIG: FlowdConfig = {
  repo: "o/r",
  defaultBranch: "main",
  trackBranch: "track/x",
  workdir: "/tmp/test-flowd",
  actor: "flow-bot",
  aiDisclaimer: "[ai]",
  reviewerIterationCap: 2,
  verifyCommand: "bun run verify",
  credentialsPath: "/tmp/c.json",
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

describe("buildPlanPorts", () => {
  test("composes tracker, forge, agent, and verify ports", () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}), "ghp_fake_test_token");
    expect(typeof ports.tracker.listSlices).toBe("function");
    expect(typeof ports.tracker.createItem).toBe("function");
    expect(typeof ports.tracker.setDependencies).toBe("function");
    expect(typeof ports.tracker.setRole).toBe("function");
    expect(typeof ports.forge.driftRefresh).toBe("function");
    expect(typeof ports.forge.createTrackBranch).toBe("function");
    expect(typeof ports.agent.planReview).toBe("function");
    expect(typeof ports.verify.run).toBe("function");
    // implement and review are NOT available in plan mode.
    expect(ports.agent.implement).toBeDefined();
    expect(ports.agent.review).toBeDefined();
  });

  test("implement throws in plan mode", async () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}), "ghp_fake_test_token");
    await expect(ports.agent.implement({ sliceId: 1, branch: "x" })).rejects.toThrow(
      "not available in plan mode",
    );
  });

  test("review throws in plan mode", async () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}), "ghp_fake_test_token");
    await expect(ports.agent.review({ sliceId: 1, branch: "x" })).rejects.toThrow(
      "not available in plan mode",
    );
  });

  test("verify gate is always green in plan mode", async () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}), "ghp_fake_test_token");
    expect(await ports.verify.run(1)).toEqual({ green: true });
  });
});

describe("planCostEstimate", () => {
  const ce: CostEstimatorConfig = {
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
  };

  test("formats cost with dollar sign and slice count", () => {
    const result = planCostEstimate([{ effort: "low" }, { effort: "medium" }], ce);
    expect(result).toContain("$");
    expect(result).toContain("2 slices");
  });

  test("handles single slice", () => {
    const result = planCostEstimate([{ effort: "low" }], ce);
    expect(result).toContain("1 slice");
  });

  test("handles undefined effort (defaults to medium)", () => {
    const result = planCostEstimate([{}], ce);
    expect(result).toContain("$");
    expect(result).toContain("1 slice");
  });
});

// ── runPlanPipeline tests ─────────────────────────────────────────────────

const CE: CostEstimatorConfig = {
  reworkMultiplier: 1.3,
  effortTokens: {
    low: { implement: 1000, review: 500 },
    medium: { implement: 3000, review: 1500 },
    high: { implement: 10000, review: 4000 },
  },
  modelPrices: { cheap: 3.0, mid: 10.0, strong: 50.0 },
  effortToModel: {
    low: { implement: "cheap", review: "strong" },
    medium: { implement: "mid", review: "strong" },
    high: { implement: "strong", review: "strong" },
  },
};

const BASE_CONFIG: FlowdConfig = {
  ...VALID_CONFIG,
  repo: "o/r",
  defaultBranch: "main",
  trackBranch: "track/test",
  workdir: "/tmp/test-flowd",
  actor: "flow-bot",
  aiDisclaimer: "[ai]",
  reviewerIterationCap: 2,
  verifyCommand: "bun run verify",
  credentialsPath: "/tmp/c.json",
  models: {
    implement: { provider: "anthropic", id: "claude-opus-4-8" },
    review: { provider: "openai", id: "gpt-5" },
    slice: { provider: "anthropic", id: "claude-opus-4-8" },
    planReview: { provider: "openai", id: "gpt-5" },
  },
};

const CANNED_PLAN: SlicePlan = {
  title: "Test Feature",
  slices: [
    {
      title: "Add login page",
      brief: "Add a basic login page with form validation",
      effort: "medium",
      category: "enhancement",
      review: "agent",
    },
    {
      title: "Add dashboard",
      brief: "Add the main dashboard view with stats",
      effort: "low",
      category: "enhancement",
      review: "agent",
      dependsOn: [0],
    },
  ],
};

const CLEAR_VERDICT = {
  decision: "CLEAR" as const,
  risks: [] as string[],
  childAgentReady: {},
};

function clearVerdictFor(ids: number[]) {
  const childAgentReady: Record<number, { pass: boolean }> = {};
  for (const id of ids) childAgentReady[id] = { pass: true };
  return { decision: "CLEAR" as const, risks: [] as string[], childAgentReady };
}

describe("runPlanPipeline — clear path with configured verdict", () => {
  test("clears the gate when slices pass agent-ready and plan-review says CLEAR", async () => {
    // We need the verdict's childAgentReady keys to match the auto-generated
    // child ids. The first created item starts at max(100, ...) + 1 = 101.
    // For 2 slices + 1 acceptance, the children are 101 and 102.
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD\n\nTest feature",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("clear");
    expect(result.childIds.length).toBe(2);
    expect(result.childIds.sort()).toEqual(childIds.sort());
    expect(result.acceptanceId).toBeGreaterThan(0);
    expect(result.risks).toEqual([]);

    // Parent advanced to tracking.
    expect(flow.track.role).toBe("tracking");
    // Track branch created.
    expect(flow.counts.createTrackBranch).toEqual(["track/test"]);
    // Plan-review agent was called once.
    expect(flow.counts.planReview).toEqual([1]);
  });

  test("includes the cost estimate in the clearance comment when costEstimator is configured", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/x",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    const config = { ...BASE_CONFIG, costEstimator: CE };
    await runPlanPipeline(flow.ports, config, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    const clearance = flow.comments.find((c) => c.body.includes("[plan-gate] Plan review cleared"));
    expect(clearance).toBeDefined();
    expect((clearance as NonNullable<typeof clearance>).body).toContain("Cost estimate");
    expect((clearance as NonNullable<typeof clearance>).body).toContain("$");
    expect((clearance as NonNullable<typeof clearance>).body).toContain("2 slices");
  });

  test("returns costEstimate in the output", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/x",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    const config = { ...BASE_CONFIG, costEstimator: CE };
    const result = await runPlanPipeline(flow.ports, config, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.costEstimate).toBeDefined();
    expect(result.costEstimate).toContain("$");
    expect(result.costEstimate).toContain("2 slices");
  });

  test("skips cost estimate when costEstimator config is absent", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/x",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    const config = { ...BASE_CONFIG, costEstimator: undefined };
    const result = await runPlanPipeline(flow.ports, config, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.costEstimate).toBeUndefined();
    const clearance = flow.comments.find((c) => c.body.includes("[plan-gate] Plan review cleared"));
    expect(clearance).toBeDefined();
    expect((clearance as NonNullable<typeof clearance>).body).not.toContain("Cost estimate");
  });

  test("writes a [slice-plan] marker comment with child IDs", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    const marker = flow.comments.find((c) => c.body.includes("[slice-plan]"));
    expect(marker).toBeDefined();
    const m = marker as NonNullable<typeof marker>;
    expect(m.body).toContain(`#${childIds[0]}`);
    expect(m.body).toContain(`#${childIds[1]}`);
    expect(m.body).toContain("Created 2 slice(s)");
    expect(m.body.startsWith("[ai]")).toBe(true);
  });

  test("writes a [plan-gate] clearance marker comment", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    const clearance = flow.comments.find((c) => c.body.includes("[plan-gate] Plan review cleared"));
    expect(clearance).toBeDefined();
    expect((clearance as NonNullable<typeof clearance>).body.startsWith("[ai]")).toBe(true);
    expect((clearance as NonNullable<typeof clearance>).body).toContain("track/test");
    expect((clearance as NonNullable<typeof clearance>).body).toContain("created off `main`");
  });
});

describe("runPlanPipeline — escalate path (T14)", () => {
  test("escalates when plan-review verdict is ESCALATE", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: {
        decision: "ESCALATE",
        risks: ["ADR conflict: T12 rewrites ADR-0016"],
        childAgentReady: { 101: { pass: true }, 102: { pass: true } },
      },
    });

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("escalate");
    expect(result.risks).toContain("ADR conflict: T12 rewrites ADR-0016");
    // Parent stays in needs-plan-review (not advanced to tracking).
    expect(flow.track.role).toBe("needs-plan-review");
    // Track branch NOT created.
    expect(flow.counts.createTrackBranch).toEqual([]);
  });

  test("escalates on deterministic effort:high leaf", async () => {
    const childIds = [101];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: clearVerdictFor(childIds),
    });

    const highPlan: SlicePlan = {
      title: "Risky Feature",
      slices: [
        {
          title: "Big migration",
          brief: "Migrate the entire database schema",
          effort: "high",
          category: "enhancement",
          review: "agent",
        },
      ],
    };

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# High risk PRD",
      plan: highPlan,
    });

    expect(result.gate).toBe("escalate");
    expect(result.risks.some((r) => r.includes("effort:high"))).toBe(true);
    expect(result.risks.some((r) => r.includes(String(childIds[0])))).toBe(true);
    expect(flow.track.role).toBe("needs-plan-review");
  });

  test("escalates when plan-review agent throws", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewError: new Error("model unavailable"),
    });

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("escalate");
    // The agent's error message must appear in risks — not the generic fallback.
    expect(result.risks).toContain("plan-review agent failed: model unavailable");
  });

  test("escalates when a child fails agent-ready", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: {
        decision: "CLEAR",
        risks: [],
        childAgentReady: {
          101: { pass: false, reason: "no verification method" },
          102: { pass: true },
        },
      },
    });

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("escalate");
    expect(
      result.risks.some((r) => r.includes("101") && r.includes("no verification method")),
    ).toBe(true);
  });

  test("posts an escalation marker comment with the named risks", async () => {
    const childIds = [101, 102];
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: {
        decision: "ESCALATE",
        risks: ["security surface: auth module touched"],
        childAgentReady: { 101: { pass: true }, 102: { pass: true } },
      },
    });

    await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    const escalation = flow.comments.find((c) =>
      c.body.includes("[plan-gate] Plan review escalated"),
    );
    expect(escalation).toBeDefined();
    const esc = escalation as NonNullable<typeof escalation>;
    expect(esc.body).toContain("security surface");
    expect(esc.body).toContain("**Risk:**");
    expect(esc.body.startsWith("[ai]")).toBe(true);
  });
});

describe("runPlanPipeline — idempotency", () => {
  test("re-running at needs-plan-review (already sliced) is a no-op for writeSlicePlan", async () => {
    // Simulate: T12 already ran (parent is needs-plan-review with children).
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-plan-review",
      trackBranch: "track/test",
      slices: [
        { id: 10, title: "Existing A", role: "ready-for-agent", closed: false },
        { id: 11, title: "Existing B", role: "ready-for-agent", closed: false },
        { id: 12, title: "Acceptance: X", role: "needs-acceptance", closed: false },
      ],
      planReviewVerdict: clearVerdictFor([10, 11]),
    });

    // Set bodies with Parent marker for dedup.
    for (const id of [10, 11]) {
      (flow.slice(id).body as string) = "## Brief\n\nbody\n\nParent: #1";
    }

    const beforeCreatedCount = flow.counts.createdItems.length;
    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    // No new items were created.
    expect(flow.counts.createdItems.length).toBe(beforeCreatedCount);
    // Existing children returned.
    expect(result.childIds.sort()).toEqual([10, 11].sort());
    expect(result.acceptanceId).toBe(12);
    // Plan-review gate still ran and cleared.
    expect(result.gate).toBe("clear");
    expect(flow.track.role).toBe("tracking");
  });

  test("re-running at tracking (gate already cleared) is a no-op for plan gate", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "tracking",
      trackBranch: "track/test",
      slices: [
        { id: 10, title: "Built slice", role: "ready-for-agent", closed: false },
        { id: 11, title: "Acceptance: X", role: "needs-acceptance", closed: false },
      ],
    });

    // Set bodies with Parent marker.
    (flow.slice(10).body as string) = "## Brief\n\nbody\n\nParent: #1";

    const beforeRoleChanges = flow.counts.roleChanges.length;
    const beforeComments = flow.comments.length;

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("clear");
    // No new role changes (already tracking).
    expect(flow.counts.roleChanges.length).toBe(beforeRoleChanges);
    // No duplicate comments posted.
    expect(flow.comments.length).toBe(beforeComments);
    // Plan-review agent was NOT called (parent already past gate).
    expect(flow.counts.planReview).toEqual([]);
    // Track branch NOT duplicated.
    expect(flow.counts.createTrackBranch).toEqual([]);
  });

  test("fully idempotent: a complete re-run is a no-op", async () => {
    // First run: needs-slicing → tracking.
    const flow1 = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: clearVerdictFor([101, 102]),
    });

    const r1 = await runPlanPipeline(flow1.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });
    expect(r1.gate).toBe("clear");
    const commentCount1 = flow1.comments.length;

    // Second run: tracking → still tracking (no-op).
    const childIds = r1.childIds;
    const id0 = childIds[0];
    const id1 = childIds[1];
    if (id0 === undefined || id1 === undefined) throw new Error("expected two child ids");
    if (r1.acceptanceId === undefined) throw new Error("expected acceptance id");

    const flow2 = makeFakeFlow({
      trackId: 1,
      trackRole: "tracking",
      trackBranch: "track/test",
      slices: [
        { id: id0, title: "Add login page", role: "ready-for-agent", closed: false },
        { id: id1, title: "Add dashboard", role: "ready-for-agent", closed: false },
        {
          id: r1.acceptanceId,
          title: "Acceptance: Test Feature",
          role: "needs-acceptance",
          closed: false,
        },
      ],
    });

    for (const id of childIds) {
      (flow2.slice(id).body as string) = "## Brief\n\nbody\n\nParent: #1";
    }

    const r2 = await runPlanPipeline(flow2.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(r2.gate).toBe("clear");
    expect(r2.childIds.sort()).toEqual(childIds.sort());
    // No new items, no new comments beyond what the first run posted.
    expect(flow2.counts.createdItems).toEqual([]);
    expect(flow2.comments.length).toBe(0);
  });

  test("re-running after escalate leaves parent in needs-plan-review with no duplicate", async () => {
    // First escalate run.
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/test",
      slices: [],
      planReviewVerdict: {
        decision: "ESCALATE",
        risks: ["risk A"],
        childAgentReady: { 101: { pass: true }, 102: { pass: true } },
      },
    });

    await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    const commentCount = flow.comments.length;
    const createdCount = flow.counts.createdItems.length;
    const roleChangeCount = flow.counts.roleChanges.length;

    // Simulate re-run: parent is still needs-plan-review (same children exist).
    const childIds = [101, 102];
    // Update the flow's state to reflect the first write.
    // The fakes don't persist across calls, so we rebuild.
    const flow2 = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-plan-review",
      trackBranch: "track/test",
      slices: [
        { id: 101, title: "Add login page", role: "ready-for-agent", closed: false },
        { id: 102, title: "Add dashboard", role: "ready-for-agent", closed: false },
        { id: 103, title: "Acceptance: Test Feature", role: "needs-acceptance", closed: false },
      ],
      planReviewVerdict: {
        decision: "ESCALATE",
        risks: ["risk A"],
        childAgentReady: { 101: { pass: true }, 102: { pass: true } },
      },
    });

    for (const id of childIds) {
      (flow2.slice(id).body as string) = "## Brief\n\nbody\n\nParent: #1";
    }

    const result = await runPlanPipeline(flow2.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# PRD",
      plan: CANNED_PLAN,
    });

    expect(result.gate).toBe("escalate");
    // No new items (dedup).
    expect(flow2.counts.createdItems).toEqual([]);
    // Still in needs-plan-review.
    expect(flow2.track.role).toBe("needs-plan-review");
  });
});

describe("runPlanPipeline — single slice edge case", () => {
  test("handles a single-slice plan", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      trackBranch: "track/solo",
      slices: [],
      planReviewVerdict: clearVerdictFor([101]),
    });

    const soloPlan: SlicePlan = {
      title: "Solo Feature",
      slices: [
        {
          title: "The only slice",
          brief: "Do everything",
          effort: "medium",
          category: "enhancement",
          review: "human",
        },
      ],
    };

    const result = await runPlanPipeline(flow.ports, BASE_CONFIG, {
      issue: 1,
      prd: "# Solo PRD",
      plan: soloPlan,
    });

    expect(result.gate).toBe("clear");
    expect(result.childIds).toEqual([101]);
    expect(result.acceptanceId).toBeGreaterThan(0);

    // The slice role should be ready-for-human (review:human).
    const created = flow.counts.createdItems.find((c) => c.title === "The only slice");
    expect(created).toBeDefined();
    expect(created?.role).toBe("ready-for-human");
  });
});
