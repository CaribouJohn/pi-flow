import { describe, expect, test } from "bun:test";
import { parseConfig, validateCostEstimatorConfig } from "../src/config.ts";
import { num } from "../src/config.ts";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";

const VALID = {
  repo: "o/r",
  defaultBranch: "main",
  trackBranch: "track/x",
  workdir: ".flowd-workdir",
  actor: "flow-bot",
  aiDisclaimer: "[ai]",
  reviewerIterationCap: 2,
  verifyCommand: "bun run verify",
  credentialsPath: "~/.flowd/credentials.json",
  models: {
    implement: { provider: "anthropic", id: "claude-opus-4-8" },
    review: { provider: "openai", id: "gpt-5" },
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

describe("parseConfig", () => {
  test("accepts a complete, valid config", () => {
    expect(parseConfig(VALID)).toMatchObject({ repo: "o/r", reviewerIterationCap: 2 });
  });

  test("rejects a same implement/review model (invariant #2)", () => {
    const same = {
      ...VALID,
      models: {
        implement: { provider: "anthropic", id: "claude-opus-4-8" },
        review: { provider: "anthropic", id: "claude-opus-4-8" },
      },
    };
    expect(() => parseConfig(same)).toThrow(/invariant #2/);
  });

  test("rejects a missing required string", () => {
    const { repo, ...rest } = VALID;
    expect(() => parseConfig(rest)).toThrow(/repo/);
  });

  test("rejects a non-positive reviewerIterationCap", () => {
    expect(() => parseConfig({ ...VALID, reviewerIterationCap: 0 })).toThrow(
      /reviewerIterationCap/,
    );
  });

  test("rejects a malformed model entry", () => {
    expect(() => parseConfig({ ...VALID, models: { implement: {}, review: {} } })).toThrow(
      /provider/,
    );
  });

  test("accepts config with costEstimator absent (optional)", () => {
    const { costEstimator, ...noCe } = VALID;
    const result = parseConfig(noCe);
    expect(result.costEstimator).toBeUndefined();
    expect(result.repo).toBe("o/r");
  });
});

// ── num() helper ───────────────────────────────────────────────────────────

describe("num", () => {
  test("accepts a positive integer", () => {
    expect(num({ x: 5 }, "x")).toBe(5);
  });

  test("accepts a positive float", () => {
    expect(num({ x: 1.3 }, "x")).toBe(1.3);
  });

  test("accepts a very small positive number (boundary)", () => {
    expect(num({ x: 0.001 }, "x")).toBe(0.001);
  });

  test("rejects a missing key", () => {
    expect(() => num({}, "x")).toThrow(/"x".*positive number/);
  });

  test("rejects null", () => {
    expect(() => num({ x: null }, "x")).toThrow(/positive number/);
  });

  test("rejects zero", () => {
    expect(() => num({ x: 0 }, "x")).toThrow(/positive number/);
  });

  test("rejects a negative number", () => {
    expect(() => num({ x: -1 }, "x")).toThrow(/positive number/);
  });

  test("rejects Infinity", () => {
    expect(() => num({ x: Number.POSITIVE_INFINITY }, "x")).toThrow(/positive number/);
  });

  test("rejects NaN", () => {
    expect(() => num({ x: Number.NaN }, "x")).toThrow(/positive number/);
  });

  test("rejects a string", () => {
    expect(() => num({ x: "1.3" }, "x")).toThrow(/positive number/);
  });
});

// ── validateCostEstimatorConfig ────────────────────────────────────────────

describe("validateCostEstimatorConfig", () => {
  const VALID_CE: CostEstimatorConfig = {
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

  test("passes a complete, valid config", () => {
    expect(() => validateCostEstimatorConfig(VALID_CE)).not.toThrow();
  });

  test("rejects missing effort level in effortToModel", () => {
    const ce: CostEstimatorConfig = {
      ...VALID_CE,
      effortToModel: {
        low: { implement: "cheap", review: "strong" },
        medium: { implement: "mid", review: "strong" },
      } as CostEstimatorConfig["effortToModel"],
    };
    expect(() => validateCostEstimatorConfig(ce)).toThrow(
      /effortToModel missing required effort "high"/,
    );
  });

  test("rejects missing model price tier referenced by effortToModel", () => {
    const ce: CostEstimatorConfig = {
      ...VALID_CE,
      modelPrices: { cheap: 3.0, mid: 10.0 },
    };
    expect(() => validateCostEstimatorConfig(ce)).toThrow(/modelPrices missing tier "strong"/);
  });

  test("rejects missing effort level in effortTokens", () => {
    const ce: CostEstimatorConfig = {
      ...VALID_CE,
      effortTokens: {
        low: { implement: 1000, review: 500 },
      } as CostEstimatorConfig["effortTokens"],
    };
    expect(() => validateCostEstimatorConfig(ce)).toThrow(
      /effortTokens missing required effort "medium"/,
    );
  });

  test("rejects missing implement tier reference", () => {
    const ce: CostEstimatorConfig = {
      ...VALID_CE,
      effortToModel: {
        ...VALID_CE.effortToModel,
        low: { implement: "premium", review: "strong" },
      },
    };
    expect(() => validateCostEstimatorConfig(ce)).toThrow(/modelPrices missing tier "premium"/);
  });

  test("rejects missing review tier reference", () => {
    const ce: CostEstimatorConfig = {
      ...VALID_CE,
      effortToModel: {
        ...VALID_CE.effortToModel,
        low: { implement: "cheap", review: "premium" },
      },
    };
    expect(() => validateCostEstimatorConfig(ce)).toThrow(/modelPrices missing tier "premium"/);
  });
});
