/**
 * Unit tests for the cost meter — accumulation, comparison, threshold flag,
 * JSONL append, and idempotency.
 *
 * No network, no tracker API — the tracker is an in-memory fake.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Effort, type SliceCost, ZERO_SLICE_COST, addSliceCosts } from "@pi-flow/flow-engine";
import type { TrackerPort } from "@pi-flow/flow-engine";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";
import {
  type CostHistoryRecord,
  CostMeterAdapter,
  type CostMeterConfig,
  appendCostRecord,
  buildCostComment,
  estimateSliceCost,
  readCostRecords,
} from "../src/cost-meter.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a SliceCost with the given values (remaining fields default to 0). */
function cost(costUSD: number, totalTokens = 100, inputTokens = 60, outputTokens = 40): SliceCost {
  return {
    costUSD,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Minimal valid CostEstimatorConfig. */
const ESTIMATOR: CostEstimatorConfig = {
  reworkMultiplier: 1.0,
  effortTokens: {
    low: { implement: 1_000, review: 500 },
    medium: { implement: 3_000, review: 1_500 },
    high: { implement: 10_000, review: 4_000 },
  },
  modelPrices: {
    cheap: 3.0, // $3/M tokens
    mid: 10.0,
    strong: 50.0,
  },
  effortToModel: {
    low: { implement: "cheap", review: "strong" },
    medium: { implement: "mid", review: "strong" },
    high: { implement: "strong", review: "strong" },
  },
};

/** Minimal cost meter config pointing at a temp file. */
function meterConfig(historyPath: string): CostMeterConfig {
  return { overrunThresholdFraction: 0.2, historyPath };
}

/** An in-memory TrackerPort that collects posted comments. */
function makeTracker(): TrackerPort & { comments: { id: number; body: string }[] } {
  const comments: { id: number; body: string }[] = [];
  return {
    comments,
    getTrack: async () => {
      throw new Error("not implemented");
    },
    listSlices: async () => [],
    setAssignee: async () => {},
    closeSlice: async () => {},
    comment: async (id, body) => {
      comments.push({ id, body });
    },
    setRole: async () => {},
    createItem: async () => 0,
    setDependencies: async () => {},
    getItemBody: async () => "",
    listByRole: async () => [],
  };
}

// ── Test scaffolding ─────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cost-meter-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── estimateSliceCost ────────────────────────────────────────────────────────

describe("estimateSliceCost", () => {
  test("returns correct estimate for medium effort", () => {
    // medium: implement 3000 tokens × $10/M + review 1500 tokens × $50/M, multiplier 1.0
    const est = estimateSliceCost("medium", ESTIMATOR);
    expect(est).toBeCloseTo((3_000 / 1_000_000) * 10 + (1_500 / 1_000_000) * 50, 8);
  });

  test("defaults to medium when effort is undefined", () => {
    expect(estimateSliceCost(undefined, ESTIMATOR)).toBe(estimateSliceCost("medium", ESTIMATOR));
  });

  test("returns correct estimate for low effort", () => {
    // low: implement 1000 × $3/M + review 500 × $50/M
    const est = estimateSliceCost("low", ESTIMATOR);
    expect(est).toBeCloseTo((1_000 / 1_000_000) * 3 + (500 / 1_000_000) * 50, 8);
  });
});

// ── buildCostComment ─────────────────────────────────────────────────────────

describe("buildCostComment", () => {
  test("within threshold — no overrun flag", () => {
    // actual $0.01, estimate $0.01 (0% delta) → within 20% threshold
    const body = buildCostComment(cost(0.01, 200), 0.01, 0.2);
    expect(body).toContain("$0.0100");
    expect(body).toContain("+0.0%");
    expect(body).toContain("within threshold");
    expect(body).not.toContain("OVERRUN");
  });

  test("overrun — flags ⚠ OVERRUN when actual > estimate × (1 + threshold)", () => {
    // actual $0.013 vs estimate $0.01 → 30% over → exceeds 20% threshold
    const body = buildCostComment(cost(0.013, 200), 0.01, 0.2);
    expect(body).toContain("OVERRUN");
    expect(body).toContain("+30.0%");
  });

  test("no estimate — shows 'no estimate on file'", () => {
    const body = buildCostComment(cost(0.005), null, 0.2);
    expect(body).toContain("no estimate on file");
    expect(body).not.toContain("OVERRUN");
  });

  test("prepends AI disclaimer when provided", () => {
    const body = buildCostComment(cost(0.001), null, 0.2, "[ai]");
    expect(body.startsWith("[ai]")).toBe(true);
  });

  test("includes token breakdown", () => {
    const body = buildCostComment(
      {
        costUSD: 0.005,
        totalTokens: 700,
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      null,
      0.2,
    );
    expect(body).toContain("Tokens: 700");
    expect(body).toContain("in 500");
    expect(body).toContain("out 200");
  });
});

// ── appendCostRecord idempotency ─────────────────────────────────────────────

describe("appendCostRecord", () => {
  function rec(sliceId: number): CostHistoryRecord {
    return {
      sliceId,
      effort: "medium",
      roles: ["implement", "review"],
      implementModel: "claude-opus-4-8",
      reviewModel: "gpt-5",
      totalTokens: 500,
      costUSD: 0.012,
      estUSD: 0.01,
      ts: new Date().toISOString(),
    };
  }

  test("appends a new record and returns true", async () => {
    const path = join(tmpDir, "history.jsonl");
    const appended = await appendCostRecord(path, rec(42));
    expect(appended).toBe(true);
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const firstLine = lines[0] ?? "";
    const parsed = JSON.parse(firstLine) as { sliceId: number };
    expect(parsed.sliceId).toBe(42);
  });

  test("skips a duplicate sliceId and returns false (idempotent)", async () => {
    const path = join(tmpDir, "history.jsonl");
    await appendCostRecord(path, rec(42));
    const second = await appendCostRecord(path, rec(42));
    expect(second).toBe(false);
    const raw = await readFile(path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("appends two different slices as separate lines", async () => {
    const path = join(tmpDir, "history.jsonl");
    await appendCostRecord(path, rec(10));
    await appendCostRecord(path, rec(20));
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? "") as { sliceId: number }).sliceId).toBe(10);
    expect((JSON.parse(lines[1] ?? "") as { sliceId: number }).sliceId).toBe(20);
  });

  test("creates parent directories when they don't exist", async () => {
    const path = join(tmpDir, "deep", "nested", "history.jsonl");
    await expect(appendCostRecord(path, rec(5))).resolves.toBe(true);
  });
});

// ── CostMeterAdapter.record ──────────────────────────────────────────────────

describe("CostMeterAdapter.record", () => {
  test("posts a tracker comment and appends a JSONL record", async () => {
    const tracker = makeTracker();
    const path = join(tmpDir, "history.jsonl");
    const adapter = new CostMeterAdapter({
      config: meterConfig(path),
      tracker,
      costEstimator: ESTIMATOR,
      implementModelId: "claude-opus-4-8",
      reviewModelId: "gpt-5",
      aiDisclaimer: "[ai]",
    });

    await adapter.record({ sliceId: 7, effort: "medium", cost: cost(0.025, 500) });

    // Comment posted
    expect(tracker.comments).toHaveLength(1);
    expect(tracker.comments[0]?.id).toBe(7);
    expect(tracker.comments[0]?.body).toContain("[ai]");
    expect(tracker.comments[0]?.body).toContain("$0.0250");

    // JSONL record appended
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim()) as CostHistoryRecord;
    expect(record.sliceId).toBe(7);
    expect(record.costUSD).toBe(0.025);
    expect(record.effort).toBe("medium");
    expect(record.implementModel).toBe("claude-opus-4-8");
    expect(record.reviewModel).toBe("gpt-5");
  });

  test("flags overrun in the comment", async () => {
    const tracker = makeTracker();
    const path = join(tmpDir, "history.jsonl");
    // medium estimate ≈ $0.105 (3000 tokens × $10/M + 1500 × $50/M)
    // We'll use actual $0.200 which is well over 20% threshold
    const adapter = new CostMeterAdapter({
      config: meterConfig(path),
      tracker,
      costEstimator: ESTIMATOR,
      implementModelId: "m1",
      reviewModelId: "m2",
    });

    await adapter.record({ sliceId: 8, effort: "medium", cost: cost(0.2, 5000) });

    expect(tracker.comments[0]?.body).toContain("OVERRUN");
  });

  test("does not throw when tracker.comment fails (never halts)", async () => {
    const tracker = makeTracker();
    // Override comment to throw
    tracker.comment = async () => {
      throw new Error("network error");
    };
    const path = join(tmpDir, "history.jsonl");
    const adapter = new CostMeterAdapter({
      config: meterConfig(path),
      tracker,
      implementModelId: "m1",
      reviewModelId: "m2",
    });
    // Should not throw
    await expect(
      adapter.record({ sliceId: 9, effort: undefined, cost: ZERO_SLICE_COST }),
    ).resolves.toBeUndefined();
  });

  test("does not throw when commitHistoryToTrack fails — logs a warning instead", async () => {
    const tracker = makeTracker();
    const path = join(tmpDir, "history.jsonl");
    const hookError = new Error("authentication failed");
    const adapter = new CostMeterAdapter({
      config: meterConfig(path),
      tracker,
      implementModelId: "m1",
      reviewModelId: "m2",
      commitHistoryToTrack: async () => {
        throw hookError;
      },
    });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Must not throw even though the hook rejects.
      await expect(
        adapter.record({ sliceId: 99, effort: "low", cost: cost(0.001) }),
      ).resolves.toBeUndefined();

      // A warning mentioning the error must have been emitted.
      const warned = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("authentication failed")),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("is idempotent — second call for same slice does not double-append JSONL", async () => {
    const tracker = makeTracker();
    const path = join(tmpDir, "history.jsonl");
    const adapter = new CostMeterAdapter({
      config: meterConfig(path),
      tracker,
      implementModelId: "m1",
      reviewModelId: "m2",
    });

    await adapter.record({ sliceId: 11, effort: "low", cost: cost(0.001) });
    await adapter.record({ sliceId: 11, effort: "low", cost: cost(0.001) });

    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1); // only one record for slice 11
  });
});

// ── readCostRecords ───────────────────────────────────────────────────────────

describe("readCostRecords", () => {
  function makeRec(sliceId: number): CostHistoryRecord {
    return {
      sliceId,
      effort: "medium",
      roles: ["implement", "review"],
      implementModel: "m1",
      reviewModel: "m2",
      totalTokens: 300,
      costUSD: 0.005,
      estUSD: 0.004,
      ts: "2025-01-01T00:00:00Z",
    };
  }

  test("returns empty array when the file does not exist", async () => {
    const path = join(tmpDir, "nonexistent.jsonl");
    const records = await readCostRecords(path);
    expect(records).toEqual([]);
  });

  test("parses valid JSONL records in order", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(
      path,
      `${[JSON.stringify(makeRec(10)), JSON.stringify(makeRec(20))].join("\n")}\n`,
    );
    const records = await readCostRecords(path);
    expect(records).toHaveLength(2);
    expect(records[0]?.sliceId).toBe(10);
    expect(records[1]?.sliceId).toBe(20);
  });

  test("skips malformed JSON lines without throwing", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(path, `not-valid-json\n${JSON.stringify(makeRec(5))}\n`);
    const records = await readCostRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(5);
  });

  test("skips records whose sliceId is not a number", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(
      path,
      `{"sliceId":"not-a-number","costUSD":0.01}\n${JSON.stringify(makeRec(42))}\n`,
    );
    const records = await readCostRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(42);
  });

  test("skips blank lines", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(path, `\n\n${JSON.stringify(makeRec(7))}\n\n`);
    const records = await readCostRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(7);
  });

  test("returns empty array when file contains only blank lines", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(path, "\n\n\n");
    const records = await readCostRecords(path);
    expect(records).toEqual([]);
  });
});

// ── addSliceCosts accumulation ───────────────────────────────────────────────

describe("addSliceCosts", () => {
  test("sums two costs correctly", () => {
    const a: SliceCost = {
      costUSD: 0.01,
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const b: SliceCost = {
      costUSD: 0.02,
      totalTokens: 400,
      inputTokens: 250,
      outputTokens: 150,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    const sum = addSliceCosts(a, b);
    expect(sum.costUSD).toBeCloseTo(0.03, 10);
    expect(sum.totalTokens).toBe(700);
    expect(sum.inputTokens).toBe(450);
    expect(sum.outputTokens).toBe(250);
    expect(sum.cacheReadTokens).toBe(10);
    expect(sum.cacheWriteTokens).toBe(5);
  });

  test("identity: adding ZERO_SLICE_COST returns an equivalent cost", () => {
    const c = cost(0.005, 100, 70, 30);
    const sum = addSliceCosts(c, ZERO_SLICE_COST);
    expect(sum).toEqual(c);
  });
});
