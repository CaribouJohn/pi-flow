/**
 * Plan-review gate — the deterministic non-LLM half of T13/T14 (SPEC §5.3).
 *
 * The plan-review *agent* (a Pi session on a different model) returns a
 * structured `PlanReviewVerdict`. This module combines it with the
 * deterministic `effort:high` smell (§4.4) into a clear-or-escalate decision,
 * then performs the tracker/git side-effects through the engine's ports.
 *
 * Every tracker write is a **marker comment** (prefixed `[plan-gate]`) so
 * re-runs are idempotent (SPEC §8.8). The fakes record them verbatim; real
 * adapters will deduplicate on the marker prefix.
 */
import type { PlanReviewVerdict, World } from "./domain.ts";
import { type RunOptions, disclaim, readWorld } from "./orchestrator.ts";
import type { OrchestratorPorts } from "./ports.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PlanGateResult {
  kind: "clear" | "escalate";
  /** The named risks (non-empty only for escalate). */
  risks: string[];
  /** The cost estimate string posted at the clear gate (optional — slice 6). */
  costEstimate?: string;
}

// ── Deterministic smell ─────────────────────────────────────────────────────

/**
 * Detect slices with `effort:high` — the deterministic escalation smell
 * (SPEC §4.4, §5.3 T14 guard). Returns the IDs of all matching children.
 */
export function detectEffortHigh(world: World): number[] {
  return world.slices.filter((s) => s.effort === "high").map((s) => s.id);
}

// ── Combine logic ───────────────────────────────────────────────────────────

/**
 * Combine the deterministic check with the agent verdict.
 *
 * Escalate (return risks array) if **either** source flags:
 *  1. Any `effort:high` leaf (deterministic).
 *  2. Agent verdict is absent/empty/null — never a silent clear.
 *  3. Agent verdict is ESCALATE.
 *  4. Agent has named risks (even under CLEAR).
 *  5. Any child fails the agent-ready check.
 *  6. Any child is missing from the agent-ready check entirely.
 *
 * Returns `null` when the gate is clean — only CLEAR, no risks, every
 * child passes agent-ready.
 */
export function combineVerdict(world: World, verdict: PlanReviewVerdict | null): string[] | null {
  // Absent/empty verdict → escalate (fail-safe — same stance as 0001's reviewer).
  if (!verdict || !verdict.decision) {
    return ["Plan review agent returned no verdict"];
  }

  const risks: string[] = [];

  // 1. Deterministic: effort:high leaves
  const highIds = detectEffortHigh(world);
  if (highIds.length > 0) {
    risks.push(`effort:high leaf detected: slice(s) ${highIds.join(", ")}`);
  }

  // 2. Agent named risks (both CLEAR+risks and ESCALATE paths)
  const agentRisks = verdict.risks ?? [];
  for (const r of agentRisks) {
    risks.push(r);
  }

  // 3. Agent ESCALATE without explicit risks — flag it
  if (verdict.decision === "ESCALATE" && agentRisks.length === 0) {
    risks.push("Agent escalated without naming specific risks");
  }

  // 4. Per-child agent-ready failures
  const checkedIds = new Set<number>();
  if (verdict.childAgentReady) {
    for (const [idStr, check] of Object.entries(verdict.childAgentReady)) {
      const id = Number(idStr);
      checkedIds.add(id);
      if (!check.pass) {
        risks.push(`Slice ${id} failed agent-ready: ${check.reason ?? "no reason given"}`);
      }
    }
  }

  // 5. Any non-acceptance child missing from agent-ready entirely.
  // Acceptance items are meta-items reviewed by humans, not agents.
  for (const slice of world.slices) {
    if (slice.role === "needs-acceptance") continue;
    if (!checkedIds.has(slice.id)) {
      risks.push(`Slice ${slice.id} has no agent-ready check`);
    }
  }

  return risks.length > 0 ? risks : null;
}

// ── Gate runner ─────────────────────────────────────────────────────────────

/**
 * Run the plan-review gate (T13/T14) for a track whose parent is in
 * `needs-plan-review`. If the parent is already past the gate (`tracking`
 * or later) this is an idempotent no-op.
 *
 * @param costEstimate — optional cost string from the estimator (slice 6);
 *   posted in the clearance marker comment when the gate clears.
 */
export async function runPlanGate(
  ports: OrchestratorPorts,
  trackId: number,
  opts: RunOptions,
  costEstimate?: string,
): Promise<PlanGateResult> {
  const track = await ports.tracker.getTrack(trackId);

  // Idempotency gate: already past needs-plan-review → no-op clear.
  if (track.role !== "needs-plan-review") {
    return { kind: "clear", risks: [], costEstimate };
  }

  const world = await readWorld(ports, track);

  // Call the plan-review agent (may throw — caught below as escalate).
  let verdict: PlanReviewVerdict | null = null;
  try {
    verdict = await ports.agent.planReview(trackId);
  } catch {
    // Agent call failed — fall through to escalate with a null verdict.
  }

  const escalateRisks = combineVerdict(world, verdict);

  if (escalateRisks !== null) {
    // T14: Escalate — leave the parent in needs-plan-review; post the risks.
    await ports.tracker.comment(
      trackId,
      disclaim(opts, `[plan-gate] Plan review escalated.\n${escalateSummary(escalateRisks)}`),
    );
    return { kind: "escalate", risks: escalateRisks };
  }

  // T13: Clear — advance parent → tracking; create the track branch.
  await ports.tracker.setRole(trackId, "tracking");
  await ports.forge.createTrackBranch(track.branch);

  const lines = [
    "[plan-gate] Plan review cleared.",
    `Track branch \`${track.branch}\` created off \`main\`.`,
  ];
  // The cost estimate (slice 6) is posted here when available.
  if (costEstimate) lines.push("", `**Cost estimate:** ${costEstimate}`);

  await ports.tracker.comment(trackId, disclaim(opts, lines.join("\n")));

  return { kind: "clear", risks: [], costEstimate };
}

function escalateSummary(risks: string[]): string {
  return risks.map((r) => `- **Risk:** ${r}`).join("\n");
}
