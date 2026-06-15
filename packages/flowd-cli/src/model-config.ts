/**
 * Role→model routing: which model each role-agent runs on.
 *
 * The load-bearing structural constraints (SPEC invariants):
 *   - `review !== implement` (invariant #2 — independent blind spots)
 *   - `planReview !== slice`   (extends #2 to the plan gate — reviewer ≠ slicer)
 */

export interface ModelId {
  provider: string;
  id: string;
}

export interface RoleModelConfig {
  implement: ModelId;
  review: ModelId;
  slice: ModelId;
  planReview: ModelId;
}

// Exact match: provider and model id are case-sensitive identifiers (as the
// provider SDKs treat them), so no normalization is applied.
export function sameModel(a: ModelId, b: ModelId): boolean {
  return a.provider === b.provider && a.id === b.id;
}

export function formatModel(m: ModelId): string {
  return `${m.provider}/${m.id}`;
}

/**
 * Enforce structural independence invariants.
 *
 *   - `review !== implement` (invariant #2 — independent blind spots).
 *   - `planReview !== slice` (extends #2 to the plan gate — the reviewer must
 *     not share a model with the slicer that produced the plan).
 *
 * Throws loudly on a same-model config so a misconfiguration fails fast.
 */
export function validateRoleModelConfig(config: RoleModelConfig): void {
  if (sameModel(config.implement, config.review)) {
    throw new Error(
      `reviewer model must differ from the implementer model (invariant #2): both resolve to ${formatModel(config.implement)}`,
    );
  }
  if (sameModel(config.planReview, config.slice)) {
    throw new Error(
      `plan-review model must differ from the slicer model (independence rule): both resolve to ${formatModel(config.planReview)}`,
    );
  }
}
