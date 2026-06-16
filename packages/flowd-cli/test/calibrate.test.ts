/**
 * Unit tests for `flowd calibrate` — suggestion math over fixture history.
 * No file I/O in the core tests; readHistoryFile is tested separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CalibrationRow,
  computeCalibration,
  formatCalibrationReport,
  readHistoryFile,
} from "../src/calibrate.ts";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";
import type { CostHistoryRecord } from "../src/cost-meter.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid CostEstimatorConfig (same shape as cost-meter tests). */
const CONFIG: CostEstimatorConfig = {
  reworkMultiplier: 1.0,
  effortTokens: {
    low: { implement: 1_000, review: 500 },
    medium: { implement: 3_000, review: 1_500 },
    high: { implement: 10_000, review: 4_000 },
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

function rec(
  sliceId: number,
  effort: CostHistoryRecord["effort"],
  totalTokens: number,
  costUSD = 0.01,
): CostHistoryRecord {
  return {
    sliceId,
    effort,
    roles: ["implement", "review"],
    implementModel: "m1",
    reviewModel: "m2",
    totalTokens,
    costUSD,
    estUSD: null,
    ts: new Date().toISOString(),
  };
}

// ── computeCalibration ───────────────────────────────────────────────────────

describe("computeCalibration", () => {
  test("returns empty array for no records", () => {
    expect(computeCalibration([], CONFIG)).toEqual([]);
  });

  test("produces two rows per effort level (implement + review)", () => {
    const records = [rec(1, "medium", 4500), rec(2, "medium", 4500)];
    const rows = computeCalibration(records, CONFIG);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.role).toBe("implement");
    expect(rows[1]?.role).toBe("review");
  });

  test("count reflects number of records in that effort group", () => {
    const records = [rec(1, "low", 1200), rec(2, "low", 1800), rec(3, "medium", 3000)];
    const rows = computeCalibration(records, CONFIG);
    const lowRows = rows.filter((r) => r.effort === "low");
    expect(lowRows[0]?.count).toBe(2);
    const medRows = rows.filter((r) => r.effort === "medium");
    expect(medRows[0]?.count).toBe(1);
  });

  test("observedMeanTokens: proportional split by configured ratio", () => {
    // medium: cfg implement=3000, review=1500 → total=4500
    // observed total = 4500 → implement share = 4500 × (3000/4500) = 3000, review = 1500
    const records = [rec(1, "medium", 4500)];
    const rows = computeCalibration(records, CONFIG);
    const implRow = rows.find((r) => r.effort === "medium" && r.role === "implement");
    const revRow = rows.find((r) => r.effort === "medium" && r.role === "review");
    expect(implRow?.observedMeanTokens).toBe(3000);
    expect(revRow?.observedMeanTokens).toBe(1500);
  });

  test("observedMeanTokens is the mean over multiple records", () => {
    // low: cfg implement=1000, review=500 → total cfg=1500
    // records: 1500 and 3000 → mean total = 2250
    // implement share = 2250 × (1000/1500) = 1500
    const records = [rec(1, "low", 1500), rec(2, "low", 3000)];
    const rows = computeCalibration(records, CONFIG);
    const implRow = rows.find((r) => r.effort === "low" && r.role === "implement");
    expect(implRow?.observedMeanTokens).toBe(1500);
  });

  test("divergencePct: positive when observed > configured", () => {
    // medium implement cfg=3000; observed total=6000 → share=4000 → +33.3%
    const records = [rec(1, "medium", 6000)];
    const rows = computeCalibration(records, CONFIG);
    const implRow = rows.find((r) => r.effort === "medium" && r.role === "implement");
    expect(implRow?.divergencePct).toBeCloseTo(33.33, 1);
    expect(implRow?.indicator).toBe("↑");
  });

  test("divergencePct: negative when observed < configured", () => {
    // medium implement cfg=3000; observed total=3000 → share=2000 → -33.3%
    const records = [rec(1, "medium", 3000)];
    const rows = computeCalibration(records, CONFIG);
    const implRow = rows.find((r) => r.effort === "medium" && r.role === "implement");
    expect(implRow?.divergencePct).toBeCloseTo(-33.33, 1);
    expect(implRow?.indicator).toBe("↓");
  });

  test("indicator is = when observed equals configured (within band)", () => {
    // medium cfg total=4500; observed=4500 → shares match exactly → 0%
    const records = [rec(1, "medium", 4500)];
    const rows = computeCalibration(records, CONFIG);
    for (const row of rows.filter((r) => r.effort === "medium")) {
      expect(row.indicator).toBe("=");
      expect(row.divergencePct).toBeCloseTo(0, 5);
    }
  });

  test("configuredTokens is null and indicator is null when no config provided", () => {
    const records = [rec(1, "medium", 4000)];
    const rows = computeCalibration(records, undefined);
    for (const row of rows) {
      expect(row.configuredTokens).toBeNull();
      expect(row.divergencePct).toBeNull();
      expect(row.indicator).toBeNull();
    }
  });

  test("effort=unknown rows have null configuredTokens", () => {
    const records = [rec(1, undefined, 2000)];
    const rows = computeCalibration(records, CONFIG);
    for (const row of rows) {
      expect(row.effort).toBe("unknown");
      expect(row.configuredTokens).toBeNull();
    }
  });

  test("rows are ordered: low → medium → high → unknown", () => {
    const records = [
      rec(1, undefined, 1000),
      rec(2, "high", 10000),
      rec(3, "low", 1500),
      rec(4, "medium", 4500),
    ];
    const rows = computeCalibration(records, CONFIG);
    const efforts = rows.filter((r) => r.role === "implement").map((r) => r.effort);
    expect(efforts).toEqual(["low", "medium", "high", "unknown"]);
  });

  test("multiple effort groups each produce two rows", () => {
    const records = [rec(1, "low", 1500), rec(2, "medium", 4500), rec(3, "high", 14000)];
    const rows = computeCalibration(records, CONFIG);
    expect(rows).toHaveLength(6); // 3 effort levels × 2 roles
  });

  test("divergencePct and indicator are consistent for both roles in same effort", () => {
    // Since observed is proportionally split from the same total,
    // the divergence % should be identical for both roles.
    const records = [rec(1, "medium", 6750)]; // 6750 vs cfg 4500 → +50%
    const rows = computeCalibration(records, CONFIG);
    const medRows = rows.filter((r) => r.effort === "medium");
    expect(medRows).toHaveLength(2);
    expect(medRows[0]?.divergencePct).toBeCloseTo(50, 1);
    expect(medRows[1]?.divergencePct).toBeCloseTo(50, 1);
    expect(medRows[0]?.indicator).toBe("↑");
    expect(medRows[1]?.indicator).toBe("↑");
  });
});

// ── formatCalibrationReport ──────────────────────────────────────────────────

describe("formatCalibrationReport", () => {
  test("empty rows returns a graceful no-history message", () => {
    const report = formatCalibrationReport([]);
    expect(report).toContain("no history records found");
    expect(report).toContain("cost-history.jsonl");
  });

  test("report header shows total slice count", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "medium",
        role: "implement",
        count: 5,
        observedMeanTokens: 3000,
        configuredTokens: 3000,
        divergencePct: 0,
        indicator: "=",
      },
      {
        effort: "medium",
        role: "review",
        count: 5,
        observedMeanTokens: 1500,
        configuredTokens: 1500,
        divergencePct: 0,
        indicator: "=",
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report).toContain("5 slices observed");
  });

  test("report includes ↑ indicator when observed > configured", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "low",
        role: "implement",
        count: 3,
        observedMeanTokens: 1200,
        configuredTokens: 1000,
        divergencePct: 20,
        indicator: "↑",
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report).toContain("↑");
    expect(report).toContain("+20.0%");
  });

  test("report includes ↓ indicator when observed < configured", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "medium",
        role: "review",
        count: 2,
        observedMeanTokens: 900,
        configuredTokens: 1500,
        divergencePct: -40,
        indicator: "↓",
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report).toContain("↓");
    expect(report).toContain("-40.0%");
  });

  test("report shows — when no config values are available", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "medium",
        role: "implement",
        count: 1,
        observedMeanTokens: 2000,
        configuredTokens: null,
        divergencePct: null,
        indicator: null,
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report).toContain("no costEstimator config");
    // The delta column should show — for missing config
    expect(report).toMatch(/—/);
  });

  test("report includes effort and role in rows", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "high",
        role: "review",
        count: 4,
        observedMeanTokens: 3800,
        configuredTokens: 4000,
        divergencePct: -5,
        indicator: "↓",
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report).toContain("high");
    expect(report).toContain("review");
  });

  test("report mentions suggestions-only disclaimer", () => {
    const rows: CalibrationRow[] = [
      {
        effort: "low",
        role: "implement",
        count: 1,
        observedMeanTokens: 900,
        configuredTokens: 1000,
        divergencePct: -10,
        indicator: "↓",
      },
    ];
    const report = formatCalibrationReport(rows);
    expect(report.toLowerCase()).toContain("suggestion");
  });
});

// ── readHistoryFile ──────────────────────────────────────────────────────────

describe("readHistoryFile", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "calibrate-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for a missing file", async () => {
    const result = await readHistoryFile(join(tmpDir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("returns empty array for an empty file", async () => {
    const path = join(tmpDir, "history.jsonl");
    await writeFile(path, "");
    const result = await readHistoryFile(path);
    expect(result).toEqual([]);
  });

  test("parses valid JSONL records", async () => {
    const path = join(tmpDir, "history.jsonl");
    const r1 = rec(1, "low", 1200);
    const r2 = rec(2, "medium", 4500);
    await writeFile(path, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
    const result = await readHistoryFile(path);
    expect(result).toHaveLength(2);
    expect(result[0]?.sliceId).toBe(1);
    expect(result[1]?.sliceId).toBe(2);
  });

  test("skips malformed JSON lines silently", async () => {
    const path = join(tmpDir, "history.jsonl");
    const r = rec(5, "high", 10000);
    await writeFile(path, `${JSON.stringify(r)}\nnot-valid-json\n`);
    const result = await readHistoryFile(path);
    expect(result).toHaveLength(1);
    expect(result[0]?.sliceId).toBe(5);
  });

  test("skips blank lines", async () => {
    const path = join(tmpDir, "history.jsonl");
    const r = rec(3, "medium", 3000);
    await writeFile(path, `\n\n${JSON.stringify(r)}\n\n`);
    const result = await readHistoryFile(path);
    expect(result).toHaveLength(1);
  });
});
