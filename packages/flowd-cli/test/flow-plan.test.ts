import { describe, expect, test } from "bun:test";
import type { FlowdConfig } from "../src/config.ts";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";
import { buildPlanPorts, planCostEstimate } from "../src/flow-plan.ts";
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
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}));
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
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}));
    await expect(ports.agent.implement({ sliceId: 1, branch: "x" })).rejects.toThrow(
      "not available in plan mode",
    );
  });

  test("review throws in plan mode", async () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}));
    await expect(ports.agent.review({ sliceId: 1, branch: "x" })).rejects.toThrow(
      "not available in plan mode",
    );
  });

  test("verify gate is always green in plan mode", async () => {
    const ports = buildPlanPorts(VALID_CONFIG, makeCredentials({}));
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
