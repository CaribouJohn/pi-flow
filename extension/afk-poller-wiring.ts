/**
 * B9 — Poller ↔ AFK loop wiring.
 *
 * Pure logic for reacting to poller diffs and detecting the
 * "fully-blocked" transition. All side effects (notify, appendEntry,
 * commentOnIssue, sendMessage) are injected via `PollerReactionDeps`
 * so the smoke can drive every branch without real gh/pi.
 *
 * ## What this module does NOT do
 *
 * - Creating or starting the Poller instance → wired in index.ts at
 *   `session_start`.
 * - Updating `issueCache` from the snapshot → deferred: IssueSnap
 *   doesn't carry `title`, so a straight setFrom is lossy. The cache
 *   continues its own lazy-refresh path (B10).
 * - Updating `latestSnapshot` for the widget → done inline in index.ts
 *   in the `onDiff` handler since it is module-scoped there.
 */

import type { Diff, Snapshot } from "./poller.ts";
import type { MutationRegistry } from "./mutation-registry.ts";

export type PollerReactionDeps = {
  /**
   * Check whether this diff was caused by one of our own mutations
   * (mutation-token buffer from B1). If true, suppress it.
   */
  isMutation(issueNumber: number, label: string): boolean;

  /** Profile label config (read at call time — profile edits take effect). */
  labels: {
    humanGate: string[];   // labels whose removal should wake the loop
    agentPickable: string; // label whose addition should wake the loop
    reviewHuman: string;   // label applied on escalation
  };

  /**
   * Wake the AFK loop. B9 fires a pi user message so that if the loop
   * is mid-turn, pi queues the resume for after the current turn.
   * The exact API is injected so the smoke does not need a real pi.
   */
  sendResume(): Promise<void>;

  /**
   * One-shot blocked-state surfacing. Called on the first tick that
   * transitions from "had work" to "fully blocked". Not called again
   * until the loop has resumed (picked an issue successfully) and
   * then re-blocked.
   */
  onFullyBlocked(blockingIssueNumbers: number[]): Promise<void>;
};

/**
 * Whether a diff should cause the loop to re-check for work.
 *
 * Wakes the loop when:
 *   - an issue LOSES a human-gate label (human unblocked it)
 *   - an issue GAINS the agent-pickable label (new work appeared)
 *
 * Pure: no I/O.
 */
export function isResumeableDiff(
  diff: Diff,
  labels: PollerReactionDeps["labels"],
): boolean {
  if (diff.kind === "label-removed") {
    return labels.humanGate.includes(diff.label);
  }
  if (diff.kind === "label-added") {
    return diff.label === labels.agentPickable;
  }
  return false;
}

/**
 * Decide whether the poller's latest snapshot means the loop is
 * fully-blocked (no open issues with the agent-pickable label).
 *
 * Pure: no I/O.
 */
export function isFullyBlocked(
  snapshot: Snapshot,
  agentPickableLabel: string,
): boolean {
  for (const issue of snapshot.issues.values()) {
    if (
      issue.state === "OPEN" &&
      issue.labels.includes(agentPickableLabel)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * State machine for one-shot blocked-state notification.
 *
 * Rule: fire `onFullyBlocked` exactly once per transition from
 * "had work" → "fully blocked". After a successful resume (the loop
 * picked an issue), reset so the NEXT block transition fires again.
 *
 * Exported so the smoke can inspect and reset state.
 */
export type BlockTransitionState = {
  hadWork: boolean;
  notifiedBlocked: boolean;
};

export function createBlockTransitionState(): BlockTransitionState {
  return { hadWork: false, notifiedBlocked: false };
}

/**
 * Process one poller tick's snapshot against the block-transition
 * state. Mutates `state` in place.
 *
 * Returns "fire" if `onFullyBlocked` should be called, otherwise
 * "noop".
 *
 * Pure logic (deps.onFullyBlocked is called by the caller, not here,
 * so this function stays testable without async).
 */
export function evaluateBlockTransition(
  state: BlockTransitionState,
  snapshot: Snapshot,
  agentPickableLabel: string,
): "fire" | "noop" {
  const blocked = isFullyBlocked(snapshot, agentPickableLabel);

  if (!blocked) {
    // There is work. Record that the loop had work; clear notification
    // flag so the next block transition fires again.
    state.hadWork = true;
    state.notifiedBlocked = false;
    return "noop";
  }

  // Blocked. Only fire if we previously had work AND haven't fired yet.
  if (state.hadWork && !state.notifiedBlocked) {
    state.notifiedBlocked = true;
    return "fire";
  }

  return "noop";
}

/**
 * Build the `onDiff` subscriber that goes into `poller.onDiff(...)`.
 *
 * The returned function is the one registered with the poller's
 * `onDiff` subscription. The caller (index.ts) also updates
 * `latestSnapshot` and `issueCache` from the snapshot before or after
 * this handler runs — that's intentionally left outside this module.
 */
export function buildOnDiffHandler(
  deps: PollerReactionDeps,
  state: BlockTransitionState,
): (diffs: Diff[], snapshot: Snapshot) => Promise<void> {
  return async (diffs: Diff[], snapshot: Snapshot) => {
    // Diff reaction: look for diffs that should wake the loop.
    for (const diff of diffs) {
      if (diff.kind !== "label-added" && diff.kind !== "label-removed") {
        continue;
      }
      if (deps.isMutation(diff.issue, diff.label)) {
        // Our own mutation — suppress.
        continue;
      }
      if (isResumeableDiff(diff, deps.labels)) {
        await deps.sendResume();
        // Don't break — multiple diffs could be relevant; sendResume
        // is idempotent (the loop's reentrancy lock handles concurrent
        // wakeups).
        break; // one sendResume per batch is enough
      }
    }

    // Block-transition detection.
    const decision = evaluateBlockTransition(
      state,
      snapshot,
      deps.labels.agentPickable,
    );
    if (decision === "fire") {
      const blockingNumbers = Array.from(snapshot.issues.values())
        .filter(
          (i) =>
            i.state === "OPEN" &&
            i.labels.includes(deps.labels.reviewHuman),
        )
        .map((i) => i.number);
      await deps.onFullyBlocked(blockingNumbers);
    }
  };
}

/* ------------------------------------------------------------------ */
/* index.ts wiring helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the PollDeps for the poller from a live pi instance.
 * Separates the `run` adapter so index.ts only needs to pass `pi`.
 */
export function buildPollDepsFromPi(pi: {
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}): import("./poller.ts").PollDeps {
  return {
    run: async (args: string[]) => {
      const r = await pi.exec("gh", args);
      return { stdout: r.stdout, stderr: r.stderr, code: r.code };
    },
  };
}
