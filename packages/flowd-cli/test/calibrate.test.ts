/**
 * Unit tests for `flowd calibrate` — suggestion math and formatting.
 *
 * All tests are pure / synchronous where possible; the async runCalibrate()
 * entry point is covered by the "empty/missing history" acceptance criterion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCalibrationRows,
  formatCalibrationReport,
  runCalibrate,
  runCalibrateFromRecords,
} from "../src/calibrate.ts";
import type { CostEstimatorConfig } from "../src/cost-estimator.ts";
import type { CostHistoryRecord } from "../src/cost-meter.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONFIG: CostEstimatorConfig = {
  reworkMultiplier: 1.0,
  effortTokens: {
    low: { implement: 1_000, review: 500 },
    medium: { implement: 3_000, review: 1_500 },
    high: { implement: 10_000, review: 4_000 },
  },
  modelPrices: { cheap: 3.0, mid: 10.0, strong: 50.0 },
  effortToModel: {
    low: { implement: "cheap", review: "strong" },
    medium: { implement: "mid", review: "strong" },
    high: { implement: "strong", review: "strong" },
  },
};

function record(
  sliceId: number,
  effort: "low" | "medium" | "high" | undefined,
  totalTokens: number,
  costUSD = 0.01,
): CostHistoryRecord {
  return {
    sliceId,
    effort,
    roles: ["implement", "review"],
    implementModel: "mid",
    reviewModel: "strong",
    totalTokens,
    costUSD,
    estUSD: null,
    ts: new Date().toISOString(),
  };
}

/** Find a row by role, asserting it exists. */
function findRole(rows: ReturnType<typeof buildCalibrationRows>, role: "implement" | "review") {
  const row = rows.find((r) => r.role === role);
  if (row === undefined) throw new Error(`No row with role="${role}" found`);
  return row;
}

// ── buildCalibrationRows ──────────────────────────────────────────────────────

describe("buildCalibrationRows", () => {
  test("returns empty array for empty records", () => {
    expect(buildCalibrationRows([], CONFIG)).toEqual([]);
  });

  test("single medium record — produces implement and review rows", () => {
    const rows = buildCalibrationRows([record(1, "medium", 4_500)], CONFIG);
    expect(rows).toHaveLength(2);
    const impl = findRole(rows, "implement");
    const rev = findRole(rows, "review");
    expect(impl.effort).toBe("medium");
    expect(impl.sampleCount).toBe(1);
    expect(rev.effort).toBe("medium");
    expect(rev.sampleCount).toBe(1);
  });

  test("configuredTokens matches effortTokens table", () => {
    const rows = buildCalibrationRows([record(1, "low", 1_500)], CONFIG);
    const impl = findRole(rows, "implement");
    const rev = findRole(rows, "review");
    expect(impl.configuredTokens).toBe(1_000);
    expect(rev.configuredTokens).toBe(500);
  });

  test("configuredTokens is null when config is absent", () => {
    const rows = buildCalibrationRows([record(1, "medium", 4_500)]);
    for (const row of rows) {
      expect(row.configuredTokens).toBeNull();
    }
  });

  test("observed tokens use configured ratio to split", () => {
    // medium: implement=3000, review=1500 → ratio 2/3 : 1/3
    const rows = buildCalibrationRows([record(1, "medium", 4_500)], CONFIG);
    const impl = findRole(rows, "implement");
    const rev = findRole(rows, "review");
    // 4500 * (3000/4500) = 3000
    expect(impl.observedMeanTokens).toBe(3_000);
    // 4500 - 3000 = 1500
    expect(rev.observedMeanTokens).toBe(1_500);
  });

  test("mean is averaged over multiple records with same effort", () => {
    const records = [
      record(1, "medium", 4_000),
      record(2, "medium", 5_000),
      record(3, "medium", 6_000),
    ];
    const rows = buildCalibrationRows(records, CONFIG);
    const impl = findRole(rows, "implement");
    // mean total = 5000; implement share = 3/4.5 of 5000
    const configRatio = 3_000 / 4_500;
    expect(impl.observedMeanTokens).toBe(Math.round(5_000 * configRatio));
    expect(impl.sampleCount).toBe(3);
  });

  test("multiple effort levels produce separate rows", () => {
    const records = [record(1, "low", 1_200), record(2, "high", 12_000)];
    const rows = buildCalibrationRows(records, CONFIG);
    const efforts = [...new Set(rows.map((r) => r.effort))];
    expect(efforts).toContain("low");
    expect(efforts).toContain("high");
    // No medium rows since no medium records.
    expect(efforts).not.toContain("medium");
  });

  test("records with undefined effort are grouped as 'unknown'", () => {
    const rows = buildCalibrationRows([record(1, undefined, 3_000)], CONFIG);
    expect(rows.every((r) => r.effort === "unknown")).toBe(true);
    // No configuredTokens for unknown effort
    for (const row of rows) {
      expect(row.configuredTokens).toBeNull();
    }
  });

  test("rows are sorted effort low → medium → high → unknown, then implement before review", () => {
    const records = [
      record(1, undefined, 2_000),
      record(2, "high", 14_000),
      record(3, "low", 1_500),
      record(4, "medium", 4_500),
    ];
    const rows = buildCalibrationRows(records, CONFIG);
    const effortOrder = rows.map((r) => `${r.effort}::${r.role}`);
    expect(effortOrder).toEqual([
      "low::implement",
      "low::review",
      "medium::implement",
      "medium::review",
      "high::implement",
      "high::review",
      "unknown::implement",
      "unknown::review",
    ]);
  });
});

// ── formatCalibrationReport ───────────────────────────────────────────────────

describe("formatCalibrationReport", () => {
  test("returns notice string when rows are empty", () => {
    const output = formatCalibrationReport([]);
    expect(output).toContain("no history data");
  });

  test("output contains effort and role labels", () => {
    const rows = buildCalibrationRows([record(1, "medium", 4_500)], CONFIG);
    const output = formatCalibrationReport(rows);
    expect(output).toContain("medium");
    expect(output).toContain("implement");
    expect(output).toContain("review");
  });

  test("↑ indicator when observed exceeds configured", () => {
    // medium: configured implement = 3000, ratio = 2/3.
    // total > 4500 → observed_impl > 3000 → ↑
    const rows = buildCalibrationRows([record(1, "medium", 6_000)], CONFIG);
    const output = formatCalibrationReport(rows);
    expect(output).toContain("↑");
  });

  test("↓ indicator when observed is below configured", () => {
    // medium: total < 4500 → observed_impl < 3000 → ↓
    const rows = buildCalibrationRows([record(1, "medium", 3_000)], CONFIG);
    const output = formatCalibrationReport(rows);
    expect(output).toContain("↓");
  });

  test("— placeholder when configured is null", () => {
    const rows = buildCalibrationRows([record(1, "medium", 4_500)]);
    const output = formatCalibrationReport(rows);
    // Without config, configuredTokens is null → "—" in configured column
    expect(output).toContain("—");
  });

  test("output mentions that config is read-only", () => {
    const rows = buildCalibrationRows([record(1, "low", 1_500)], CONFIG);
    const output = formatCalibrationReport(rows);
    expect(output).toContain("read-only");
  });

  test("header row is present", () => {
    const rows = buildCalibrationRows([record(1, "low", 1_500)], CONFIG);
    const output = formatCalibrationReport(rows);
    expect(output).toContain("effort");
    expect(output).toContain("role");
    expect(output).toContain("configured");
    expect(output).toContain("observed");
  });
});

// ── runCalibrate (async I/O) ──────────────────────────────────────────────────

describe("runCalibrate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "flowd-calibrate-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("handles a missing history file gracefully — no throw", async () => {
    const missing = join(tmpDir, "no-such-file.jsonl");
    // Should not throw; just print the "no history data" notice.
    await expect(runCalibrate(missing, CONFIG)).resolves.toBeUndefined();
  });

  test("handles an empty history file gracefully", async () => {
    const emptyPath = join(tmpDir, "empty.jsonl");
    await writeFile(emptyPath, "", "utf8");
    await expect(runCalibrate(emptyPath, CONFIG)).resolves.toBeUndefined();
  });

  test("reads records from a real JSONL file and does not throw", async () => {
    const historyPath = join(tmpDir, "history.jsonl");
    const rec1 = record(1, "medium", 4_500);
    const rec2 = record(2, "low", 1_200);
    await writeFile(historyPath, `${JSON.stringify(rec1)}\n${JSON.stringify(rec2)}\n`, "utf8");
    await expect(runCalibrate(historyPath, CONFIG)).resolves.toBeUndefined();
  });
});

// ── runCalibrateFromRecords ─────────────────────────────────────────────────

describe("runCalibrateFromRecords", () => {
  test("empty records — logs 'no history data' notice", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      runCalibrateFromRecords([]);
    } finally {
      console.log = orig;
    }
    const output = lines.join("\n");
    expect(output).toContain("no history data");
  });

  test("valid records — logs the calibration table without throwing", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      runCalibrateFromRecords([record(1, "medium", 4_500)], CONFIG);
    } finally {
      console.log = orig;
    }
    const output = lines.join("\n");
    expect(output).toContain("medium");
    expect(output).toContain("implement");
  });

  test("records with undefined effort — logs 'unknown' rows without throwing", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      runCalibrateFromRecords([record(1, undefined, 3_000)]);
    } finally {
      console.log = orig;
    }
    const output = lines.join("\n");
    expect(output).toContain("unknown");
  });

  test("no config provided — still prints table with '—' for configured column", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      runCalibrateFromRecords([record(1, "medium", 4_500)]);
    } finally {
      console.log = orig;
    }
    const output = lines.join("\n");
    // No config → configuredTokens null → '—' placeholder.
    expect(output).toContain("—");
  });
});

// ── planInvocation for calibrate ─────────────────────────────────────────────

describe("planInvocation calibrate", () => {
  test("recognises the calibrate command", async () => {
    const { planInvocation } = await import("../src/cli.ts");
    expect(planInvocation(["calibrate"])).toEqual({ kind: "calibrate", config: undefined });
  });

  test("calibrate passes through --config", async () => {
    const { planInvocation } = await import("../src/cli.ts");
    expect(planInvocation(["calibrate", "--config", "my.json"])).toEqual({
      kind: "calibrate",
      config: "my.json",
    });
  });
});
