import { describe, expect, test } from "bun:test";
import {
  type CostEstimatorConfig,
  type SliceWithEffort,
  estimateTrackCost,
} from "../src/cost-estimator.ts";

// ── Provisional v1 config matching the example — used for formula tests ─────

const PROVISIONAL_CONFIG: CostEstimatorConfig = {
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

// ── Manual verification of the Σ formula ────────────────────────────────────

describe("estimateTrackCost", () => {
  test("returns zero total for an empty slice set", () => {
    const result = estimateTrackCost([], PROVISIONAL_CONFIG);
    expect(result.total).toBe(0);
    expect(result.sliceCount).toBe(0);
    expect(result.formatted).toBe("≈ $0.00, 0 slices");
  });

  test("formats singular 'slice' when sliceCount is 1", () => {
    const slices: SliceWithEffort[] = [{ effort: "low" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.formatted).toContain("1 slice");
  });

  test("formats plural 'slices' when sliceCount > 1", () => {
    const slices: SliceWithEffort[] = [{ effort: "low" }, { effort: "low" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.formatted).toContain("2 slices");
  });

  // ── Formula spot-checks (hand-computed) ──────────────────────────────────

  test("computes a single low-effort slice correctly", () => {
    // implement: 1000 tokens × $3.00/1M = $0.003
    // review:     500 tokens × $50.00/1M = $0.025
    // slice cost = $0.028
    // × 1.3 = $0.0364 → $0.04 (rounded)
    const slices: SliceWithEffort[] = [{ effort: "low" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.sliceCount).toBe(1);
    expect(result.total).toBeCloseTo(0.0364, 4);
    expect(result.formatted).toBe("≈ $0.04, 1 slice");
  });

  test("computes a single medium-effort slice correctly", () => {
    // implement: 3000 tokens × $10.00/1M = $0.03
    // review:    1500 tokens × $50.00/1M = $0.075
    // slice cost = $0.105
    // × 1.3 = $0.1365
    const slices: SliceWithEffort[] = [{ effort: "medium" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.total).toBeCloseTo(0.1365, 4);
  });

  test("computes a single high-effort slice correctly", () => {
    // implement: 10000 tokens × $50.00/1M = $0.50
    // review:     4000 tokens × $50.00/1M = $0.20
    // slice cost = $0.70
    // × 1.3 = $0.91
    const slices: SliceWithEffort[] = [{ effort: "high" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.total).toBeCloseTo(0.91, 4);
  });

  test("sums multiple slices of mixed efforts correctly", () => {
    // low:  (1000×3 + 500×50)  / 1e6 = 0.003 + 0.025 = 0.028
    // med:  (3000×10 + 1500×50) / 1e6 = 0.03 + 0.075 = 0.105
    // high: (10000×50 + 4000×50) / 1e6 = 0.50 + 0.20 = 0.70
    // Σ = 0.833 × 1.3 = 1.0829
    const slices: SliceWithEffort[] = [{ effort: "low" }, { effort: "medium" }, { effort: "high" }];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.total).toBeCloseTo(1.0829, 4);
    expect(result.sliceCount).toBe(3);
  });

  test("defaults unset effort to medium", () => {
    // Medium: (3000×10 + 1500×50) / 1e6 = 0.105 × 1.3 = 0.1365
    const slices: SliceWithEffort[] = [{}]; // no effort set
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.total).toBeCloseTo(0.1365, 4);
  });

  test("handles a mix of explicit and default effort", () => {
    // low (explicit): 0.028
    // undefined → medium: 0.105
    // Σ = 0.133 × 1.3 = 0.1729
    const slices: SliceWithEffort[] = [{ effort: "low" }, {}];
    const result = estimateTrackCost(slices, PROVISIONAL_CONFIG);
    expect(result.total).toBeCloseTo(0.1729, 4);
  });

  test("scales with rework multiplier (verify multiplier ≠ 1)", () => {
    const config: CostEstimatorConfig = {
      ...PROVISIONAL_CONFIG,
      reworkMultiplier: 2.0,
    };
    // medium slice × 1.3 = 0.1365; × 2.0 = 0.21
    const slices: SliceWithEffort[] = [{ effort: "medium" }];
    const result = estimateTrackCost(slices, config);
    expect(result.total).toBeCloseTo(0.21, 4);
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  test("throws when effort→tokens is missing a referenced effort", () => {
    const config: CostEstimatorConfig = {
      ...PROVISIONAL_CONFIG,
      effortTokens: {
        low: { implement: 1, review: 1 },
        medium: { implement: 1, review: 1 },
      } as CostEstimatorConfig["effortTokens"],
    };
    const slices: SliceWithEffort[] = [{ effort: "high" }];
    expect(() => estimateTrackCost(slices, config)).toThrow(/effort→tokens/);
  });

  test("throws when effort→model is missing a referenced effort", () => {
    const config: CostEstimatorConfig = {
      ...PROVISIONAL_CONFIG,
      effortToModel: {
        low: { implement: "cheap", review: "strong" },
        medium: { implement: "mid", review: "strong" },
      } as CostEstimatorConfig["effortToModel"],
    };
    const slices: SliceWithEffort[] = [{ effort: "high" }];
    expect(() => estimateTrackCost(slices, config)).toThrow(/effort→model/);
  });

  test("rework multiplier of 1.0 produces no scaling (boundary)", () => {
    const config: CostEstimatorConfig = { ...PROVISIONAL_CONFIG, reworkMultiplier: 1.0 };
    // medium: (3000×10 + 1500×50) / 1e6 = 0.105
    const slices: SliceWithEffort[] = [{ effort: "medium" }];
    const result = estimateTrackCost(slices, config);
    expect(result.total).toBeCloseTo(0.105, 4);
  });
});
