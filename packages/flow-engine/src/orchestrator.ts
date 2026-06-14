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
import type { Slice, World } from "./domain.ts";
import type { OrchestratorPorts } from "./ports.ts";

export type Action =
  | { kind: "claim"; sliceId: number }
  | { kind: "implement"; sliceId: number }
  | { kind: "reimplement"; sliceId: number }
  | { kind: "review"; sliceId: number }
  | { kind: "merge"; sliceId: number }
  | { kind: "park"; sliceId: number; reason: string }
  | { kind: "done" };

type ExecutableAction = Exclude<Action, { kind: "done" } | { kind: "park" }>;

export interface RunOptions {
  /** Bounds the changes-requested loop (S6a) and the verify-retry loop (S3). */
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

  for (;;) {
    const world = await readWorld(ports, trackId);
    const action = decide(world, opts.reviewerIterationCap);

    if (action.kind === "done") return { steps, outcome: "fixpoint" };

    if (action.kind === "park") {
      await ports.tracker.comment(action.sliceId, disclaim(opts, `Parked: ${action.reason}.`));
      steps.push({ action: "park", sliceId: action.sliceId, detail: action.reason });
      return { steps, outcome: "parked", parkedReason: action.reason };
    }

    const outcome = await apply(action, world, ports, opts);
    if (outcome.park !== undefined) {
      await ports.tracker.comment(action.sliceId, disclaim(opts, `Parked: ${outcome.park}.`));
      steps.push({ action: "park", sliceId: action.sliceId, detail: outcome.park });
      return { steps, outcome: "parked", parkedReason: outcome.park };
    }
    steps.push({ action: action.kind, sliceId: action.sliceId, detail: outcome.detail });
  }
}

async function readWorld(ports: OrchestratorPorts, trackId: number): Promise<World> {
  const track = await ports.tracker.getTrack(trackId);
  const trackerSlices = await ports.tracker.listSlices(trackId);
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
): Promise<ApplyOutcome> {
  const slice = world.slices.find((s) => s.id === action.sliceId);
  if (slice === undefined) throw new Error(`apply: slice ${action.sliceId} not in world`);

  switch (action.kind) {
    case "claim":
      await ports.tracker.setAssignee(slice.id, opts.actor);
      return { detail: `assignee=${opts.actor}` };

    case "implement":
    case "reimplement":
      return implementSlice(action.kind, slice, world, ports, opts);

    case "review": {
      const pr = requirePr(slice, "review");
      const verdict = await ports.agent.review(agentContext(slice));
      await ports.forge.recordReviewVerdict(pr.number, verdict);
      await ports.tracker.comment(slice.id, disclaim(opts, reviewComment(verdict)));
      return { detail: `review: ${verdict.decision}` };
    }

    case "merge": {
      const pr = requirePr(slice, "merge");
      // Invariant #3 — never merge past a red gate. Re-check at merge time.
      const gate = await ports.verify.run(slice.id);
      if (!gate.green) return { park: redGate("verify gate red at merge", gate.output) };
      await ports.forge.mergePr(pr.number);
      if (slice.branch !== null) await ports.forge.deleteBranch(slice.branch);
      await ports.tracker.closeSlice(slice.id);
      await ports.tracker.comment(
        slice.id,
        disclaim(opts, "Merged into the track branch; slice closed."),
      );
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

  // S2 + S3 — implement, then the verify gate must go green (bounded retries).
  let green = false;
  let lastOutput: string | undefined;
  for (let attempt = 1; attempt <= opts.reviewerIterationCap && !green; attempt++) {
    await ports.agent.implement({
      sliceId: slice.id,
      branch,
      priorFindings: attempt === 1 ? priorFindings : undefined,
    });
    const gate = await ports.verify.run(slice.id);
    green = gate.green;
    lastOutput = gate.output;
  }
  if (!green) {
    return {
      park: redGate(`verify gate red after ${opts.reviewerIterationCap} attempt(s)`, lastOutput),
    };
  }

  if (kind === "reimplement" && slice.pr !== null) {
    await ports.forge.reopenForReview(slice.pr.number);
    return { detail: `re-implemented; PR #${slice.pr.number} re-opened for review` };
  }

  // S5 — open the slice PR with base = the track branch.
  const pr = await ports.forge.openPr(slice.id, world.track.branch);
  return { detail: `PR #${pr.number} opened (base=${pr.base})` };
}

function agentContext(slice: Slice) {
  return { sliceId: slice.id, branch: slice.branch ?? "", priorFindings: slice.pr?.lastFindings };
}

function requirePr(slice: Slice, step: string) {
  if (slice.pr === null) throw new Error(`${step}: slice ${slice.id} has no PR`);
  return slice.pr;
}

function reviewComment(verdict: { decision: string; findings: string[] }): string {
  const head = `Reviewer verdict: **${verdict.decision}**`;
  if (verdict.findings.length === 0) return head;
  return `${head}\n\n${verdict.findings.map((f) => `- ${f}`).join("\n")}`;
}

function redGate(reason: string, output?: string): string {
  return output ? `${reason}: ${output}` : reason;
}

function disclaim(opts: RunOptions, body: string): string {
  return opts.aiDisclaimer ? `${opts.aiDisclaimer}\n\n${body}` : body;
}
