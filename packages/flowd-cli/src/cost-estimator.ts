/**
 * Deterministic cost estimator — a `flowd` capability (HARNESS-DESIGN §8.1),
 * not an agent skill. After slicing, estimates a track's pre-flight cost from
 * `Σ over slices (implement + review)`, routed through static config tables
 * and multiplied by a fixed rework factor.
 *
 * The tables are explicitly **provisional v1 guesses**, kept in config (not
 * code) and labelled as such; calibration from measured actuals is PRD-0004's
 * meter (out of scope here).
 */
import type { Effort } from "@pi-flow/flow-engine";

// ── Config types ─────────────────────────────────────────────────────────────

/**
 * Static `effort → expected tokens` table.
 * One entry per supported effort level, giving the total expected token count
 * (input + output) for the implementer and the reviewer. PROVISIONAL v1.
 */
export type EffortTokensTable = Record<Effort, { implement: number; review: number }>;

/**
 * Static `model tier → price` table. Keys are abstract tier names (e.g. "cheap",
 * "mid", "strong") that the `effortToModel` routing maps into. Values are USD
 * dollars per 1M tokens (blended input+output). PROVISIONAL v1.
 */
export type ModelPricesTable = Record<string, number>;

/**
 * Effort → model-tier routing: for each effort level, which model tier runs
 * the implementer and which runs the reviewer. PROVISIONAL v1.
 */
export type EffortModelRouting = Record<Effort, { implement: string; review: string }>;

export interface CostEstimatorConfig {
  /** ALL values in this section are PROVISIONAL v1 guesses — calibration from
   *  measured actuals is PRD-0004 (out of scope). */
  reworkMultiplier: number;
  /** Expected total tokens per effort level, per role. PROVISIONAL. */
  effortTokens: EffortTokensTable;
  /** Model price per 1M blended tokens. Maps model tier names to $/1M. PROVISIONAL. */
  modelPrices: ModelPricesTable;
  /** Maps effort level → model tier for each role. PROVISIONAL. */
  effortToModel: EffortModelRouting;
}

// ── Input / output types ────────────────────────────────────────────────────

/** Minimal slice shape the estimator needs — just the effort level. */
export interface SliceWithEffort {
  effort?: Effort;
}

export interface CostEstimate {
  /** Total estimated cost in USD (× rework multiplier applied). */
  total: number;
  /** Number of slices included in the sum. */
  sliceCount: number;
  /** Human-readable gate comment e.g. `≈ $4.50, 5 slices`. */
  formatted: string;
}

// ── Estimator ───────────────────────────────────────────────────────────────

const DEFAULT_EFFORT: Effort = "medium";
const ONE_MILLION = 1_000_000;

/**
 * Compute the pre-flight cost estimate for a track from its slice set.
 *
 * Formula:
 * ```
 * estimate = Σ over slices ( implementCost + reviewCost ) × reworkMultiplier
 *   where roleCost = effortTokens[effort][role] / 1e6 × modelPrices[effortToModel[effort][role]]
 * ```
 *
 * Slices with no explicit effort default to `"medium"`. Throws loudly when a
 * referenced config key is missing (fail-fast on misconfiguration).
 */
export function estimateTrackCost(
  slices: SliceWithEffort[],
  config: CostEstimatorConfig,
): CostEstimate {
  let total = 0;

  for (const slice of slices) {
    const effort: Effort = slice.effort ?? DEFAULT_EFFORT;

    const tokens = config.effortTokens[effort];
    if (!tokens) {
      throw new Error(
        `cost estimator: no effort→tokens entry for "${effort}" — add it to config costEstimator.effortTokens`,
      );
    }

    const models = config.effortToModel[effort];
    if (!models) {
      throw new Error(
        `cost estimator: no effort→model entry for "${effort}" — add it to config costEstimator.effortToModel`,
      );
    }

    const implPrice = config.modelPrices[models.implement];
    if (implPrice === undefined) {
      throw new Error(
        `cost estimator: no model price for "${models.implement}" (routed from effort "${effort}" implementer) — add it to config costEstimator.modelPrices`,
      );
    }

    const revPrice = config.modelPrices[models.review];
    if (revPrice === undefined) {
      throw new Error(
        `cost estimator: no model price for "${models.review}" (routed from effort "${effort}" reviewer) — add it to config costEstimator.modelPrices`,
      );
    }

    const implCost = (tokens.implement / ONE_MILLION) * implPrice;
    const revCost = (tokens.review / ONE_MILLION) * revPrice;
    total += implCost + revCost;
  }

  total *= config.reworkMultiplier;

  return {
    total,
    sliceCount: slices.length,
    formatted: `≈ $${total.toFixed(2)}, ${slices.length} slice${slices.length === 1 ? "" : "s"}`,
  };
}
