/**
 * Smoke for afk-poller-wiring. Run with:
 *   bun extension/afk-poller-wiring.smoke.ts
 */

import {
  buildOnDiffHandler,
  createBlockTransitionState,
  evaluateBlockTransition,
  isFullyBlocked,
  isResumeableDiff,
  type BlockTransitionState,
  type PollerReactionDeps,
} from "./afk-poller-wiring.ts";
import type { Diff, Snapshot } from "./poller.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

const LABELS: PollerReactionDeps["labels"] = {
  humanGate: ["review:human", "needs-info"],
  agentPickable: "ready-for-agent",
  reviewHuman: "review:human",
};

function makeSnapshot(issues: Array<{ number: number; state: "OPEN" | "CLOSED"; labels: string[] }>): Snapshot {
  const map = new Map(
    issues.map((i) => [
      i.number,
      { number: i.number, state: i.state, labels: i.labels, assignees: [], updatedAt: "" },
    ]),
  );
  return { issues: map, prs: new Map(), ts: Date.now() };
}

// ====================================================================
// isResumeableDiff
// ====================================================================

check(
  "resumeable: label-removed human-gate",
  isResumeableDiff(
    { kind: "label-removed", issue: 1, label: "review:human", ts: 0 },
    LABELS,
  ),
);
check(
  "resumeable: label-removed other human-gate",
  isResumeableDiff(
    { kind: "label-removed", issue: 1, label: "needs-info", ts: 0 },
    LABELS,
  ),
);
check(
  "resumeable: label-added agent-pickable",
  isResumeableDiff(
    { kind: "label-added", issue: 1, label: "ready-for-agent", ts: 0 },
    LABELS,
  ),
);
check(
  "not resumeable: label-added non-pickable",
  !isResumeableDiff(
    { kind: "label-added", issue: 1, label: "needs-info", ts: 0 },
    LABELS,
  ),
);
check(
  "not resumeable: label-removed agent-pickable (issue taken off queue)",
  !isResumeableDiff(
    { kind: "label-removed", issue: 1, label: "ready-for-agent", ts: 0 },
    LABELS,
  ),
);
check(
  "not resumeable: opened",
  !isResumeableDiff({ kind: "opened", issue: 1, ts: 0 }, LABELS),
);
check(
  "not resumeable: closed",
  !isResumeableDiff({ kind: "closed", issue: 1, ts: 0 }, LABELS),
);

// ====================================================================
// isFullyBlocked
// ====================================================================

check(
  "fully-blocked: no open issues with pickable label",
  isFullyBlocked(makeSnapshot([{ number: 1, state: "OPEN", labels: ["needs-info"] }]), "ready-for-agent"),
);
check(
  "not fully-blocked: one open pickable issue",
  !isFullyBlocked(
    makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]),
    "ready-for-agent",
  ),
);
check(
  "not fully-blocked: closed pickable issue doesn't count",
  isFullyBlocked(
    makeSnapshot([{ number: 1, state: "CLOSED", labels: ["ready-for-agent"] }]),
    "ready-for-agent",
  ),
);
check("fully-blocked: empty snapshot", isFullyBlocked(makeSnapshot([]), "ready-for-agent"));

// ====================================================================
// evaluateBlockTransition
// ====================================================================

// Initial state: no work seen yet → block fires no notification
{
  const s = createBlockTransitionState();
  const blocked = makeSnapshot([]);
  const r = evaluateBlockTransition(s, blocked, "ready-for-agent");
  check("block-transition: initial blocked → noop (no prior work)", r === "noop");
  check("block-transition: hadWork still false after initial block", !s.hadWork);
}

// See work, then see block → fires
{
  const s = createBlockTransitionState();
  const withWork = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  evaluateBlockTransition(s, withWork, "ready-for-agent");
  check("block-transition: after work snapshot, hadWork=true", s.hadWork);
  check("block-transition: after work snapshot, notifiedBlocked=false", !s.notifiedBlocked);

  const noWork = makeSnapshot([]);
  const r = evaluateBlockTransition(s, noWork, "ready-for-agent");
  check("block-transition: work→block fires", r === "fire");
  check("block-transition: notifiedBlocked=true after fire", s.notifiedBlocked);
}

// Second consecutive blocked tick → no double fire
{
  const s = createBlockTransitionState();
  const withWork = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  evaluateBlockTransition(s, withWork, "ready-for-agent");
  const noWork = makeSnapshot([]);
  evaluateBlockTransition(s, noWork, "ready-for-agent");
  const r2 = evaluateBlockTransition(s, noWork, "ready-for-agent");
  check("block-transition: second consecutive block → noop (no double fire)", r2 === "noop");
}

// Resume after block, then re-block → fires again
{
  const s = createBlockTransitionState();
  const withWork = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  evaluateBlockTransition(s, withWork, "ready-for-agent");
  const noWork = makeSnapshot([]);
  evaluateBlockTransition(s, noWork, "ready-for-agent"); // fire (first block)
  evaluateBlockTransition(s, withWork, "ready-for-agent"); // work returns
  const r = evaluateBlockTransition(s, noWork, "ready-for-agent"); // re-block
  check("block-transition: re-block after resume → fires again", r === "fire");
}

// ====================================================================
// buildOnDiffHandler — resume path (label-removed human-gate)
// ====================================================================

{
  let resumeCalled = 0;
  let blockedCalled = 0;
  const state = createBlockTransitionState();
  // Seed hadWork so block transitions can fire
  evaluateBlockTransition(
    state,
    makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]),
    "ready-for-agent",
  );

  const deps: PollerReactionDeps = {
    isMutation: () => false,
    labels: LABELS,
    sendResume: async () => { resumeCalled++; },
    onFullyBlocked: async () => { blockedCalled++; },
  };
  const handler = buildOnDiffHandler(deps, state);

  // Diff: review:human removed (not our mutation)
  const diffs: Diff[] = [
    { kind: "label-removed", issue: 1, label: "review:human", ts: 0 },
  ];
  const snapshot = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  await handler(diffs, snapshot);
  check("resume path: sendResume called", resumeCalled === 1);
  check("resume path: onFullyBlocked NOT called (has work)", blockedCalled === 0);
}

// ====================================================================
// buildOnDiffHandler — suppression path (our mutation)
// ====================================================================

{
  let resumeCalled = 0;
  const state = createBlockTransitionState();
  // Seed hadWork
  evaluateBlockTransition(
    state,
    makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]),
    "ready-for-agent",
  );

  const deps: PollerReactionDeps = {
    isMutation: (issue, label) => issue === 1 && label === "review:human",
    labels: LABELS,
    sendResume: async () => { resumeCalled++; },
    onFullyBlocked: async () => {},
  };
  const handler = buildOnDiffHandler(deps, state);
  const diffs: Diff[] = [
    { kind: "label-removed", issue: 1, label: "review:human", ts: 0 },
  ];
  const snapshot = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  await handler(diffs, snapshot);
  check("suppression: sendResume NOT called (our mutation)", resumeCalled === 0);
}

// ====================================================================
// buildOnDiffHandler — transition-to-blocked path
// ====================================================================

{
  let blockedCalled = 0;
  let blockedIssueNums: number[] = [];
  const state = createBlockTransitionState();
  // Seed hadWork
  evaluateBlockTransition(
    state,
    makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]),
    "ready-for-agent",
  );

  const deps: PollerReactionDeps = {
    isMutation: () => false,
    labels: LABELS,
    sendResume: async () => {},
    onFullyBlocked: async (nums) => { blockedCalled++; blockedIssueNums = nums; },
  };
  const handler = buildOnDiffHandler(deps, state);

  // Snapshot with no pickable issues, but has review:human issues
  const blockedSnapshot = makeSnapshot([
    { number: 5, state: "OPEN", labels: ["review:human"] },
    { number: 6, state: "OPEN", labels: ["needs-info"] },
  ]);
  await handler([], blockedSnapshot);
  check("blocked path: onFullyBlocked called", blockedCalled === 1);
  check("blocked path: review:human issues reported", blockedIssueNums.includes(5));
  check("blocked path: non-human-gate issues not in list", !blockedIssueNums.includes(6));

  // Second tick still blocked → no double fire
  await handler([], blockedSnapshot);
  check("blocked path: no double fire on second blocked tick", blockedCalled === 1);
}

// ====================================================================
// buildOnDiffHandler — re-block after resume fires again
// ====================================================================

{
  let blockedCalled = 0;
  const state = createBlockTransitionState();

  const deps: PollerReactionDeps = {
    isMutation: () => false,
    labels: LABELS,
    sendResume: async () => {},
    onFullyBlocked: async () => { blockedCalled++; },
  };
  const handler = buildOnDiffHandler(deps, state);

  const withWork = makeSnapshot([{ number: 1, state: "OPEN", labels: ["ready-for-agent"] }]);
  const noWork = makeSnapshot([]);

  await handler([], withWork);  // see work
  await handler([], noWork);    // first block → fire (blockedCalled=1)
  await handler([], withWork);  // resume
  await handler([], noWork);    // re-block → fire again (blockedCalled=2)
  check("re-block: fires again after resume", blockedCalled === 2);
}

// ====================================================================
// Done
// ====================================================================

if (failed === 0) {
  console.log("\nALL PASS");
  process.exit(0);
} else {
  console.error(`\n${failed} CHECK(S) FAILED`);
  process.exit(1);
}
