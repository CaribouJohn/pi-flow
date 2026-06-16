/**
 * `flowd calibrate` — read-only calibration report.
 *
 * Reads `.flowd/cost-history.jsonl`, aggregates by effort level, and prints
 * observed-mean tokens/cost vs the configured estimate-table values with
 * an ↑/↓ divergence indicator.  Mutates nothing.
 */
import type { Effort } from "@pi-flow/flow-engine";
import type { CostEstimatorConfig } from "./cost-estimator.ts";
import type { CostHistoryRecord } from "./cost-meter.ts";
import { readCostRecords } from "./cost-meter.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** One summary row: one effort level × one role (implement | review). */
export interface CalibrationRow {
  effort: Effort | "unknown";
  role: "implement" | "review";
  /** Configured token estimate for this (effort, role) pair, or null when absent. */
  configuredTokens: number | null;
  /** Observed mean total-tokens attributed to this role (half of combined total). */
  observedMeanTokens: number;
  /** Number of history records that contributed to this row. */
  sampleCount: number;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Bucket {
  tokenSum: number;
  count: number;
}

/**
 * Aggregate history records into per-(effort, role) CalibrationRows.
 *
 * Because the history records store `totalTokens` (implement + review combined),
 * this function splits that evenly between the two roles using the configured
 * ratio when a config is available, or 50/50 otherwise.
 *
 * Pass `config` so the split can mirror the configured effortTokens ratio;
 * omit it for a plain 50/50 split.
 */
export function buildCalibrationRows(
  records: CostHistoryRecord[],
  config?: CostEstimatorConfig,
): CalibrationRow[] {
  // Accumulate per-(effort, role) buckets.
  const buckets = new Map<string, Bucket>();

  const key = (effort: Effort | "unknown", role: "implement" | "review") => `${effort}::${role}`;

  for (const rec of records) {
    const effort: Effort | "unknown" = rec.effort ?? "unknown";
    const total = rec.totalTokens;

    // Determine implement/review split ratio from config if available.
    let implRatio = 0.5;
    if (config && effort !== "unknown") {
      const et = config.effortTokens[effort as Effort];
      if (et) {
        const configTotal = et.implement + et.review;
        implRatio = configTotal > 0 ? et.implement / configTotal : 0.5;
      }
    }

    const implTokens = Math.round(total * implRatio);
    const revTokens = total - implTokens;

    for (const [role, tokens] of [
      ["implement", implTokens],
      ["review", revTokens],
    ] as const) {
      const k = key(effort, role);
      const existing = buckets.get(k);
      if (existing) {
        existing.tokenSum += tokens;
        existing.count += 1;
      } else {
        buckets.set(k, { tokenSum: tokens, count: 1 });
      }
    }
  }

  // Build output rows, sorted by effort then role.
  const EFFORT_ORDER: Array<Effort | "unknown"> = ["low", "medium", "high", "unknown"];
  const ROLE_ORDER: Array<"implement" | "review"> = ["implement", "review"];

  const rows: CalibrationRow[] = [];
  for (const effort of EFFORT_ORDER) {
    for (const role of ROLE_ORDER) {
      const k = `${effort}::${role}`;
      const bucket = buckets.get(k);
      if (!bucket) continue;

      const configuredTokens =
        config && effort !== "unknown"
          ? (config.effortTokens[effort as Effort]?.[role] ?? null)
          : null;

      rows.push({
        effort,
        role,
        configuredTokens,
        observedMeanTokens: Math.round(bucket.tokenSum / bucket.count),
        sampleCount: bucket.count,
      });
    }
  }

  return rows;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Render an arrow and percentage delta when a configured baseline exists. */
function divergence(configured: number | null, observed: number): string {
  if (configured === null || configured === 0) return "";
  const delta = (observed - configured) / configured;
  const pct = (Math.abs(delta) * 100).toFixed(1);
  const arrow = delta > 0 ? "↑" : "↓";
  return `${arrow} ${pct}%`;
}

/** Format `n` as a locale-style integer with thousands separators. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render the calibration table as a human-readable string.
 * Returns a short notice when `rows` is empty.
 */
export function formatCalibrationReport(rows: CalibrationRow[]): string {
  if (rows.length === 0) {
    return "calibrate: no history data — run some slices first.";
  }

  const COL = {
    effort: 10,
    role: 11,
    samples: 9,
    configured: 14,
    observed: 14,
    delta: 12,
  };

  const pad = (s: string, w: number) => s.padEnd(w);
  const padL = (s: string, w: number) => s.padStart(w);

  const header = [
    pad("effort", COL.effort),
    pad("role", COL.role),
    padL("samples", COL.samples),
    padL("configured", COL.configured),
    padL("observed mean", COL.observed),
    pad("delta", COL.delta),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines: string[] = ["", header, sep];

  for (const row of rows) {
    const cfgStr = row.configuredTokens !== null ? fmt(row.configuredTokens) : "—";
    const obsStr = fmt(row.observedMeanTokens);
    const div = divergence(row.configuredTokens, row.observedMeanTokens);

    lines.push(
      [
        pad(row.effort, COL.effort),
        pad(row.role, COL.role),
        padL(String(row.sampleCount), COL.samples),
        padL(cfgStr, COL.configured),
        padL(obsStr, COL.observed),
        div,
      ].join("  "),
    );
  }

  lines.push("");
  lines.push("  ↑ = observed exceeds configured  ↓ = observed below configured");
  lines.push("  Configured values are in flowd.config.json → costEstimator.effortTokens.");
  lines.push("  This report is read-only — edit config manually to adjust estimates.");
  lines.push("");

  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Read the cost-history JSONL and print the calibration report to stdout.
 * Never throws; missing/empty history prints a graceful notice.
 */
export async function runCalibrate(
  historyPath: string,
  config?: CostEstimatorConfig,
): Promise<void> {
  const records = await readCostRecords(historyPath);
  const rows = buildCalibrationRows(records, config);
  console.log(formatCalibrationReport(rows));
}
