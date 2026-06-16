/**
 * The orchestrator — a stateless reducer over (tracker + forge) (SPEC §0, §8.2).
 *
 * `decide` is a pure function from a world snapshot to the next legal action;
 * `runTrack` reads the world, applies one action, and repeats to a fixpoint
 * (no assignable/in-flight slice left) or a park (a gate it cannot clear).
 * Holding no state between ticks is what makes the loop resumable and idempotent
 * (SPEC §8.8): a duplicate run over a finished world is a no-op.
 */
import { isAssignable } from "./derive.ts";
import {
  type Slice,
  type SliceCost,
  type Track,
  type World,
  ZERO_SLICE_COST,
  addSliceCosts,
} from "./domain.ts";
import type { OrchestratorPorts } from "./ports.ts";

export type Action =
  | { kind: "claim"; sliceId: number }
  | { kind: "implement"; sliceId: number }
  | { kind: "reimplement"; sliceId: number }
  | { kind: "review"; sliceId: number }
  | { kind: "merge"; sliceId: number }
  /**
   * §8.8 — a slice whose PR was merged outside the loop (by a maintainer or bot).
   * The orchestrator closes the tracker item instead of re-implementing.
   */
  | { kind: "close"; sliceId: number }
  | { kind: "park"; sliceId: number; reason: string }
  | { kind: "done" };

type ExecutableAction = Exclude<Action, { kind: "done" } | { kind: "park" }>;

export interface RunOptions {
  /**
   * Maximum number of *review rounds* before a still-rejected slice parks.
   * After this many REQUEST_CHANGES verdicts the track parks for a human — it
   * does NOT count re-implements (cap=1 ⇒ one review; a single REQUEST_CHANGES
   * parks with zero re-implements). Bounds the S6a loop only; the verify gate
   * (S3) is gated once per implement — the implementer agent owns iterating to
   * green internally (SPEC §8.7).
   */
  reviewerIterationCap: number;
  /** Who claims a slice (the assignee = the lock). */
  actor: string;
  /** Prefixed to every tracker write (the profile's AI disclaimer). */
  aiDisclaimer?: string;
}

export interface Step {
  action: ExecutableAction["kind"] | "park";
  sliceId: number;
  detail?: string;
}

export interface RunResult {
  steps: Step[];
  outcome: "fixpoint" | "parked";
  parkedReason?: string;
}

interface ApplyOutcome {
  detail?: string;
  /** Set when a gate the orchestrator cannot clear forces a park. */
  park?: string;
  /** Metered cost produced by this action (implement or review). */
  cost?: SliceCost;
}

/**
 * Pure scheduler: pick the next legal action for the track.
 *
 * Single-threaded by construction (PRD scope): a slice is only claimed when no
 * other slice is in-flight, so the per-slice loop runs to completion before the
 * next is picked. Precedence: drive the in-flight slice forward, else claim the
 * next assignable, else we are at a fixpoint.
 */
export function decide(world: World, reviewerIterationCap: number): Action {
  const open = world.slices.filter((s) => !s.closed);

  const inFlight = open.find((s) => s.assignee !== null);
  if (inFlight !== undefined) {
    const pr = inFlight.pr;
    if (pr === null) return { kind: "implement", sliceId: inFlight.id };
    switch (pr.status) {
      case "open":
        // S6h — a review:human slice is handed off to the maintainer, never
        // gated by the agent reviewer (SPEC §5.4 S6h).
        if (inFlight.review === "human") {
          return {
            kind: "park",
            sliceId: inFlight.id,
            reason: "awaiting human review (review:human) — S6h handoff",
          };
        }
        return { kind: "review", sliceId: inFlight.id };
      case "approved":
        return { kind: "merge", sliceId: inFlight.id };
      case "changes-requested":
        if (pr.reviewAttempts < reviewerIterationCap) {
          return { kind: "reimplement", sliceId: inFlight.id };
        }
        return {
          kind: "park",
          sliceId: inFlight.id,
          reason: `reviewer still requesting changes after ${reviewerIterationCap} review(s)`,
        };
      case "merged":
        // §8.8 — PR was merged outside the loop; treat the slice as done.
        return { kind: "close", sliceId: inFlight.id };
    }
  }

  const assignable = open.find((s) => isAssignable(s, world));
  if (assignable !== undefined) return { kind: "claim", sliceId: assignable.id };

  return { kind: "done" };
}

/** Drive a track's slice loop (S0–S8) to a fixpoint or a park. */
export async function runTrack(
  ports: OrchestratorPorts,
  trackId: number,
  opts: RunOptions,
): Promise<RunResult> {
  const steps: Step[] = [];
  const track = await ports.tracker.getTrack(trackId);

  // S0 — drift-refresh on (re)entry. Idempotent: a no-op when already current.
  await ports.forge.driftRefresh(track.branch);

  // Accumulate metered cost per slice across implement + review sessions.
  // Keyed by sliceId; populated by apply() via the returned `cost` field.
  const sliceCosts = new Map<number, SliceCost>();

  for (;;) {
    const world = await readWorld(ports, track);
    const action = decide(world, opts.reviewerIterationCap);

    if (action.kind === "done") return { steps, outcome: "fixpoint" };

    if (action.kind === "park") {
      await ports.tracker.comment(action.sliceId, disclaim(opts, `Parked: ${action.reason}.`));
      steps.push({ action: "park", sliceId: action.sliceId, detail: action.reason });
      return { steps, outcome: "parked", parkedReason: action.reason };
    }

    const outcome = await apply(action, world, ports, opts, sliceCosts);
    if (outcome.park !== undefined) {
      await ports.tracker.comment(action.sliceId, disclaim(opts, `Parked: ${outcome.park}.`));
      steps.push({ action: "park", sliceId: action.sliceId, detail: outcome.park });
      return { steps, outcome: "parked", parkedReason: outcome.park };
    }
    steps.push({ action: action.kind, sliceId: action.sliceId, detail: outcome.detail });
  }
}

export async function readWorld(ports: OrchestratorPorts, track: Track): Promise<World> {
  const trackerSlices = await ports.tracker.listSlices(track.id);
  const slices: Slice[] = await Promise.all(
    trackerSlices.map(async (ts) => ({
      ...ts,
      branch: await ports.forge.getSliceBranch(ts.id),
      pr: await ports.forge.getSlicePr(ts.id),
    })),
  );
  return { track, slices };
}

async function apply(
  action: ExecutableAction,
  world: World,
  ports: OrchestratorPorts,
  opts: RunOptions,
  sliceCosts: Map<number, SliceCost>,
): Promise<ApplyOutcome> {
  const slice = world.slices.find((s) => s.id === action.sliceId);
  if (slice === undefined) throw new Error(`apply: slice ${action.sliceId} not in world`);

  switch (action.kind) {
    case "claim":
      await ports.tracker.setAssignee(slice.id, opts.actor);
      return { detail: `assignee=${opts.actor}` };

    case "implement":
    case "reimplement": {
      const outcome = await implementSlice(action.kind, slice, world, ports, opts);
      // Accumulate implement cost even when parking (partial cost still counts).
      if (outcome.cost !== undefined) {
        const prev = sliceCosts.get(slice.id) ?? ZERO_SLICE_COST;
        sliceCosts.set(slice.id, addSliceCosts(prev, outcome.cost));
      }
      return outcome;
    }

    case "review": {
      const pr = requirePr(slice, "review");
      // The reviewer investigates the slice fresh — it is NOT handed the prior
      // round's findings (those are implementer context, fed back on S6a).
      const { verdict, cost: reviewCost } = await ports.agent.review({
        sliceId: slice.id,
        branch: requireBranch(slice, "review"),
      });
      // Accumulate review cost.
      const prevReview = sliceCosts.get(slice.id) ?? ZERO_SLICE_COST;
      sliceCosts.set(slice.id, addSliceCosts(prevReview, reviewCost));
      await ports.forge.recordReviewVerdict(pr.number, verdict);
      await ports.tracker.comment(slice.id, disclaim(opts, reviewComment(verdict)));
      return { detail: `review: ${verdict.decision}` };
    }

    case "close": {
      if (slice.branch !== null) await ports.forge.deleteBranch(slice.branch);
      await ports.tracker.closeSlice(slice.id);
      await ports.tracker.comment(
        slice.id,
        disclaim(opts, "PR was merged outside the loop — slice closed (§8.8)."),
      );
      return { detail: `closed slice (PR #${slice.pr?.number ?? "?"} merged out-of-band)` };
    }

    case "merge": {
      const pr = requirePr(slice, "merge");
      // Bring the slice up to date with the track first: siblings may have
      // merged during this run, leaving it stale (its merge commit can't be
      // created). A conflict can't be auto-resolved — park for a human.
      const fresh = await ports.forge.refreshSliceFromTrack(slice.id, world.track.branch);
      if (!fresh) {
        return { park: "merge conflict with the track branch — needs manual resolution" };
      }
      // Invariant #3 — never merge past a red gate. Re-check after the refresh
      // (the track-merge may have broken the build).
      const gate = await ports.verify.run(slice.id);
      if (!gate.green) return { park: redGate("verify gate red at merge", gate.output) };
      await ports.forge.mergePr(pr.number);
      if (slice.branch !== null) await ports.forge.deleteBranch(slice.branch);
      await ports.tracker.closeSlice(slice.id);
      await ports.tracker.comment(
        slice.id,
        disclaim(opts, "Merged into the track branch; slice closed."),
      );
      // Cost-meter recording at merge time — never halts the build.
      if (ports.costMeter !== undefined) {
        const totalCost = sliceCosts.get(slice.id);
        if (totalCost !== undefined) {
          await ports.costMeter
            .record({ sliceId: slice.id, effort: slice.effort, cost: totalCost })
            .catch((err: unknown) => {
              console.warn(
                `[cost-meter] record failed for slice #${slice.id} (ignored): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
      }
      return { detail: `merged PR #${pr.number}; closed slice` };
    }
  }
}

async function implementSlice(
  kind: "implement" | "reimplement",
  slice: Slice,
  world: World,
  ports: OrchestratorPorts,
  opts: RunOptions,
): Promise<ApplyOutcome> {
  const branch =
    slice.branch ?? (await ports.forge.createSliceBranch(slice.id, world.track.branch));
  const priorFindings = kind === "reimplement" ? slice.pr?.lastFindings : undefined;

  // S2 — implement. The agent owns iterating to a green verify gate internally
  // (SPEC §8.7); the orchestrator gates S3 once and parks on a red result.
  const implCost = await ports.agent.implement({ sliceId: slice.id, branch, priorFindings });
  const gate = await ports.verify.run(slice.id);
  if (!gate.green) {
    return { park: redGate("verify gate red", gate.output), cost: implCost };
  }

  if (kind === "reimplement" && slice.pr !== null) {
    // Publish the re-implementation to origin BEFORE reopening — otherwise the
    // PR diff stays at the original code and the reviewer never sees the fix.
    await ports.forge.pushSlice(slice.id);
    await ports.forge.reopenForReview(slice.pr.number);
    return {
      detail: `re-implemented; PR #${slice.pr.number} re-opened for review`,
      cost: implCost,
    };
  }

  // S5 — open the slice PR with base = the track branch.
  const pr = await ports.forge.openPr(slice.id, world.track.branch);
  return { detail: `PR #${pr.number} opened (base=${pr.base})`, cost: implCost };
}

function requirePr(slice: Slice, step: string) {
  if (slice.pr === null) throw new Error(`${step}: slice ${slice.id} has no PR`);
  return slice.pr;
}

function requireBranch(slice: Slice, step: string): string {
  if (slice.branch === null) throw new Error(`${step}: slice ${slice.id} has no branch`);
  return slice.branch;
}

function reviewComment(verdict: { decision: string; findings: string[] }): string {
  const head = `Reviewer verdict: **${verdict.decision}**`;
  if (verdict.findings.length === 0) return head;
  return `${head}\n\n${verdict.findings.map((f) => `- ${f}`).join("\n")}`;
}

function redGate(reason: string, output?: string): string {
  return output ? `${reason}: ${output}` : reason;
}

export function disclaim(opts: RunOptions, body: string): string {
  return opts.aiDisclaimer ? `${opts.aiDisclaimer}\n\n${body}` : body;
}
