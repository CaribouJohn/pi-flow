/**
 * Minimal role→model routing for the walking skeleton: which model each role
 * agent runs on. The full per-role × effort routing table firms up later
 * (HARNESS-DESIGN §4); for now we only need the implement/review pair, and the
 * one load-bearing constraint — they must differ (SPEC invariant #2).
 */

export interface ModelId {
  provider: string;
  id: string;
}

export interface RoleModelConfig {
  implement: ModelId;
  review: ModelId;
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
 * Enforce invariant #2 structurally: the reviewer must run on a different model
 * than the implementer (independent blind spots, not just a fresh context).
 * Throws loudly on a same-model config so a misconfiguration fails fast.
 */
export function validateRoleModelConfig(config: RoleModelConfig): void {
  if (sameModel(config.implement, config.review)) {
    throw new Error(
      `reviewer model must differ from the implementer model (invariant #2): both resolve to ${formatModel(config.implement)}`,
    );
  }
}
