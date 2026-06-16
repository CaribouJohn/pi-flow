/**
 * flowd calibrate — read-only comparison of accumulated cost-history actuals
 * against the configured estimate tables.  Mutates nothing.
 *
 * Aggregates `.flowd/cost-history.jsonl` by (effort, role) and prints the
 * observed mean tokens/cost versus the configured estimate-table values, with
 * an up/down indicator when they diverge.
 */
import { readFile } from "node:fs/promises";
import type { Effort } from "@pi-flow/flow-engine";
import type { CostEstimatorConfig } from "./cost-estimator.ts";
import type { CostHistoryRecord } from "./cost-meter.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const EFFORTS = ["low", "medium", "high"] as const;
type Role = "implement" | "review";
const ROLES: Role[] = ["implement", "review"];

/** Percentage band within which we show "=" instead of ↑/↓. */
const EQ_BAND_PCT = 0.5;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Calibration data for one (effort, role) pair.
 *
 * `observedMeanTokens` is the mean of `totalTokens` (implement + review combined)
 * scaled proportionally to this role's share of the configured total.  When
 * no config is available the raw per-record mean is divided equally between
 * the two roles.  This means the `divergencePct` for both roles within an
 * effort group is identical — it reflects the overall slice accuracy, surfacing
 * which configured number needs adjusting.
 */
export interface CalibrationRow {
  effort: Effort | "unknown";
  role: Role;
  /** Number of history records grouped under this effort level. */
  count: number;
  /**
   * Observed mean tokens attributed to this role (proportional split of total).
   * Rounded to the nearest integer.
   */
  observedMeanTokens: number;
  /** Configured token estimate for this (effort, role). `null` when config absent. */
  configuredTokens: number | null;
  /**
   * (observedMean − configured) / configured × 100.
   * `null` when config absent or configured is zero.
   */
  divergencePct: number | null;
  /** ↑ observed > configured + band, ↓ observed < configured − band, = within band. */
  indicator: "↑" | "↓" | "=" | null;
}

// ── File I/O ──────────────────────────────────────────────────────────────────

/**
 * Read and parse a cost-history JSONL file.
 * Returns an empty array when the file is missing or contains no valid records.
 * Invalid JSON lines are silently skipped.
 */
export async function readHistoryFile(historyPath: string): Promise<CostHistoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (err) {
    // File absent or unreadable — treat as empty history.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }

  const records: CostHistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as CostHistoryRecord);
    } catch {
      // Skip malformed lines.
    }
  }
  return records;
}

// ── Core math ────────────────────────────────────────────────────────────────

/**
 * Compute calibration rows from history records and optional config.
 *
 * One row is produced per (effort, role) combination present in the records.
 * Rows are ordered: low → medium → high → unknown.
 */
export function computeCalibration(
  records: CostHistoryRecord[],
  config: CostEstimatorConfig | undefined,
): CalibrationRow[] {
  if (records.length === 0) return [];

  // Group records by effort.
  const groups = new Map<Effort | "unknown", CostHistoryRecord[]>();
  for (const record of records) {
    const key: Effort | "unknown" = record.effort ?? "unknown";
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(record);
  }

  // Deterministic order: known efforts first, then "unknown".
  const orderedKeys: (Effort | "unknown")[] = [
    ...EFFORTS.filter((e) => groups.has(e)),
    ...(groups.has("unknown") ? (["unknown"] as const) : []),
  ];

  const rows: CalibrationRow[] = [];

  for (const effort of orderedKeys) {
    const group = groups.get(effort) ?? [];
    const count = group.length;
    const meanTotal = group.reduce((sum, r) => sum + r.totalTokens, 0) / count;

    for (const role of ROLES) {
      const cfgImpl =
        config !== undefined && effort !== "unknown"
          ? (config.effortTokens[effort]?.implement ?? null)
          : null;
      const cfgRev =
        config !== undefined && effort !== "unknown"
          ? (config.effortTokens[effort]?.review ?? null)
          : null;

      const configuredTokens = role === "implement" ? cfgImpl : cfgRev;
      const cfgTotal = cfgImpl !== null && cfgRev !== null ? cfgImpl + cfgRev : null;

      // Proportionally attribute observed total to this role.
      let observedMeanTokens: number;
      if (cfgTotal !== null && cfgTotal > 0 && configuredTokens !== null) {
        observedMeanTokens = Math.round(meanTotal * (configuredTokens / cfgTotal));
      } else {
        // No config — split evenly between roles.
        observedMeanTokens = Math.round(meanTotal / 2);
      }

      let divergencePct: number | null = null;
      let indicator: "↑" | "↓" | "=" | null = null;

      if (configuredTokens !== null && configuredTokens > 0) {
        divergencePct = ((observedMeanTokens - configuredTokens) / configuredTokens) * 100;
        if (divergencePct > EQ_BAND_PCT) indicator = "↑";
        else if (divergencePct < -EQ_BAND_PCT) indicator = "↓";
        else indicator = "=";
      }

      rows.push({
        effort,
        role,
        count,
        observedMeanTokens,
        configuredTokens,
        divergencePct,
        indicator,
      });
    }
  }

  return rows;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Right-pad a string to width. */
function lpad(s: string, w: number): string {
  return s.padEnd(w);
}

/** Left-pad a string to width (right-align numbers). */
function rpad(s: string, w: number): string {
  return s.padStart(w);
}

/**
 * Format a calibration row-set into a human-readable table string.
 * Called from the CLI entry but also exposed for tests.
 */
export function formatCalibrationReport(rows: CalibrationRow[]): string {
  if (rows.length === 0) {
    return "flowd calibrate — no history records found\n(run some slices first to accumulate cost-history.jsonl)";
  }

  const lines: string[] = [];
  const totalCount = rows.length > 0 ? (rows[0]?.count ?? 0) : 0;
  // Derive actual total unique record count from the data.
  const effortCounts = new Map<string, number>();
  for (const r of rows) {
    if (!effortCounts.has(`${r.effort}`)) {
      effortCounts.set(`${r.effort}`, r.count);
    }
  }
  const total = [...effortCounts.values()].reduce((s, n) => s + n, 0);
  const hasConfig = rows.some((r) => r.configuredTokens !== null);

  lines.push(`flowd calibrate — ${total} slice${total === 1 ? "" : "s"} observed`);
  if (!hasConfig) {
    lines.push("(no costEstimator config — configured column shows —)");
  }
  lines.push("");

  // Header
  const COL = { effort: 8, role: 11, n: 5, obs: 14, cfg: 14, delta: 12 };
  const header = [
    lpad("effort", COL.effort),
    lpad("role", COL.role),
    rpad("n", COL.n),
    rpad("obs tokens", COL.obs),
    rpad("cfg tokens", COL.cfg),
    lpad("δ", COL.delta),
  ].join("  ");
  lines.push(header);
  lines.push("─".repeat(header.length));

  for (const row of rows) {
    const obsStr = row.observedMeanTokens.toLocaleString();
    const cfgStr = row.configuredTokens !== null ? row.configuredTokens.toLocaleString() : "—";

    let deltaStr: string;
    if (row.divergencePct !== null && row.indicator !== null) {
      const sign = row.divergencePct >= 0 ? "+" : "";
      deltaStr = `${row.indicator} ${sign}${row.divergencePct.toFixed(1)}%`;
    } else {
      deltaStr = "—";
    }

    lines.push(
      [
        lpad(row.effort, COL.effort),
        lpad(row.role, COL.role),
        rpad(String(row.count), COL.n),
        rpad(obsStr, COL.obs),
        rpad(cfgStr, COL.cfg),
        lpad(deltaStr, COL.delta),
      ].join("  "),
    );
  }

  lines.push("");
  lines.push("Observed tokens: proportional share of mean(totalTokens) per effort group.");
  lines.push("Suggestions only — edit effortTokens in flowd config to update estimates.");

  return lines.join("\n");
}

// ── Entry point for the CLI command ──────────────────────────────────────────

/**
 * Run the calibrate command: read history, compute rows, return formatted report.
 * Mutates nothing.
 */
export async function runCalibrate(opts: {
  historyPath: string;
  config: CostEstimatorConfig | undefined;
}): Promise<string> {
  const records = await readHistoryFile(opts.historyPath);
  const rows = computeCalibration(records, opts.config);
  return formatCalibrationReport(rows);
}
