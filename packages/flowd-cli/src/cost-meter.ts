/**
 * Actual-cost meter for flowd slices (PRD-0004 back-bookend).
 *
 * At slice merge time the orchestrator calls `CostMeterAdapter.record()` with
 * the accumulated `SliceCost` (Σ implement + review session usages).  The
 * adapter then:
 *
 *  1. Looks up the slice's pre-flight estimate from `costEstimator` config.
 *  2. Computes % delta; flags an overrun when actual > estimate × (1 + threshold).
 *  3. Posts a structured tracker comment on the slice issue.
 *  4. Appends one JSON-L record to `historyPath` (idempotent — skips if
 *     the same sliceId is already present to prevent double-counting on re-run).
 *
 * Errors are swallowed: overruns are flagged but never halt the build.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CostMeterPort, TrackerPort } from "@pi-flow/flow-engine";
import type { Effort, SliceCost } from "@pi-flow/flow-engine";
import type { CostEstimatorConfig } from "./cost-estimator.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface CostMeterConfig {
  /**
   * Fraction above the estimate that triggers an overrun warning.
   * E.g. `0.2` = warn when actual > estimate × 1.2 (20% over).
   */
  overrunThresholdFraction: number;
  /**
   * Path to the JSONL cost-history file, relative to cwd or absolute.
   * Defaults to `.flowd/cost-history.jsonl` in the example config.
   */
  historyPath: string;
}

// ── JSONL record ─────────────────────────────────────────────────────────────

export interface CostHistoryRecord {
  /** Slice issue number. */
  sliceId: number;
  /** Effort level of the slice (if set). */
  effort: Effort | undefined;
  /** Roles that ran (always implement+review for a merged slice). */
  roles: string[];
  /** Implement model id. */
  implementModel: string;
  /** Review model id. */
  reviewModel: string;
  /** Total token count across both sessions. */
  totalTokens: number;
  /** Actual cost in USD. */
  costUSD: number;
  /** Estimated cost in USD (from pre-flight estimator), or null when absent. */
  estUSD: number | null;
  /** ISO-8601 timestamp of when the record was written. */
  ts: string;
}

// ── Estimator helper ─────────────────────────────────────────────────────────

const DEFAULT_EFFORT: Effort = "medium";
const ONE_MILLION = 1_000_000;

/**
 * Compute the estimated cost for a single slice given its effort level.
 * Returns `null` when `costEstimator` config is absent.
 */
export function estimateSliceCost(effort: Effort | undefined, config: CostEstimatorConfig): number {
  const e = effort ?? DEFAULT_EFFORT;
  const tokens = config.effortTokens[e];
  if (!tokens) return 0;
  const models = config.effortToModel[e];
  if (!models) return 0;
  const implPrice = config.modelPrices[models.implement] ?? 0;
  const revPrice = config.modelPrices[models.review] ?? 0;
  const implCost = (tokens.implement / ONE_MILLION) * implPrice;
  const revCost = (tokens.review / ONE_MILLION) * revPrice;
  return (implCost + revCost) * config.reworkMultiplier;
}

// ── Tracker comment ──────────────────────────────────────────────────────────

/**
 * Build the slice cost comment body.
 *
 * Example:
 * ```
 * 💰 **Slice cost**: $0.0043 actual / $0.0039 est (+10.3%) — within threshold
 * Tokens: 850 (in 600 / out 250)
 * ```
 */
export function buildCostComment(
  cost: SliceCost,
  estUSD: number | null,
  thresholdFraction: number,
  aiDisclaimer?: string,
): string {
  const actualStr = `$${cost.costUSD.toFixed(4)}`;
  let headline: string;

  if (estUSD === null || estUSD === 0) {
    headline = `💰 **Slice cost**: ${actualStr} actual (no estimate on file)`;
  } else {
    const delta = (cost.costUSD - estUSD) / estUSD;
    const pct = (delta * 100).toFixed(1);
    const sign = delta >= 0 ? "+" : "";
    const estStr = `$${estUSD.toFixed(4)}`;
    const overrun = delta > thresholdFraction;
    const flag = overrun ? " ⚠ **OVERRUN**" : " — within threshold";
    headline = `💰 **Slice cost**: ${actualStr} actual / ${estStr} est (${sign}${pct}%)${flag}`;
  }

  const tokenLine = `Tokens: ${cost.totalTokens} (in ${cost.inputTokens} / out ${cost.outputTokens}${
    cost.cacheReadTokens > 0 ? ` / cache-read ${cost.cacheReadTokens}` : ""
  })`;

  const body = [headline, tokenLine].join("\n");
  return aiDisclaimer ? `${aiDisclaimer}\n\n${body}` : body;
}

// ── JSONL idempotency ─────────────────────────────────────────────────────────

/**
 * Read the history file and return the set of slice IDs already recorded.
 * Returns an empty set when the file is absent or unreadable.
 */
async function readRecordedSliceIds(historyPath: string): Promise<Set<number>> {
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    return new Set();
  }
  const ids = new Set<number>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as { sliceId?: unknown };
      if (typeof rec.sliceId === "number") ids.add(rec.sliceId);
    } catch {
      // ignore malformed lines
    }
  }
  return ids;
}

/**
 * Append one JSONL record, ensuring the parent directory exists.
 * Returns `false` when the sliceId is already recorded (idempotent).
 */
export async function appendCostRecord(
  historyPath: string,
  record: CostHistoryRecord,
): Promise<boolean> {
  const existing = await readRecordedSliceIds(historyPath);
  if (existing.has(record.sliceId)) {
    return false; // already recorded — skip
  }
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(record)}\n`, "utf8");
  return true;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface CostMeterAdapterOptions {
  config: CostMeterConfig;
  tracker: TrackerPort;
  costEstimator?: CostEstimatorConfig;
  /** Model id used for implement sessions — included in history records. */
  implementModelId: string;
  /** Model id used for review sessions — included in history records. */
  reviewModelId: string;
  /** Prefixed to every tracker write (the profile's AI disclaimer). */
  aiDisclaimer?: string;
}

/**
 * Implements `CostMeterPort`.
 *
 * Called by the orchestrator at slice merge time via `record()`. Must NOT throw:
 * all errors are caught internally so overruns never halt the build.
 */
export class CostMeterAdapter implements CostMeterPort {
  private readonly config: CostMeterConfig;
  private readonly tracker: TrackerPort;
  private readonly costEstimator: CostEstimatorConfig | undefined;
  private readonly implementModelId: string;
  private readonly reviewModelId: string;
  private readonly aiDisclaimer: string | undefined;

  constructor(opts: CostMeterAdapterOptions) {
    this.config = opts.config;
    this.tracker = opts.tracker;
    this.costEstimator = opts.costEstimator;
    this.implementModelId = opts.implementModelId;
    this.reviewModelId = opts.reviewModelId;
    this.aiDisclaimer = opts.aiDisclaimer;
  }

  async record(params: {
    sliceId: number;
    effort: Effort | undefined;
    cost: SliceCost;
  }): Promise<void> {
    const { sliceId, effort, cost } = params;

    const estUSD =
      this.costEstimator !== undefined ? estimateSliceCost(effort, this.costEstimator) : null;

    // 1. Post tracker comment (swallow errors — overruns never halt).
    try {
      const body = buildCostComment(
        cost,
        estUSD,
        this.config.overrunThresholdFraction,
        this.aiDisclaimer,
      );
      await this.tracker.comment(sliceId, body);
    } catch (err) {
      console.warn(
        `[cost-meter] comment failed for slice #${sliceId} (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 2. Append to cost-history JSONL (idempotent).
    try {
      const record: CostHistoryRecord = {
        sliceId,
        effort,
        roles: ["implement", "review"],
        implementModel: this.implementModelId,
        reviewModel: this.reviewModelId,
        totalTokens: cost.totalTokens,
        costUSD: cost.costUSD,
        estUSD,
        ts: new Date().toISOString(),
      };
      await appendCostRecord(this.config.historyPath, record);
    } catch (err) {
      console.warn(
        `[cost-meter] history append failed for slice #${sliceId} (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
