/**
 * Smoke for afk-loop. Run with:
 *   bun extension/afk-loop.smoke.ts
 *
 * Drives the full state graph with stubbed deps; never touches gh/git/fs.
 */

import {
  composePrBody,
  composeTaskBrief,
  formatImplementerFailComment,
  formatReviewerFailComment,
  formatVerifyFailComment,
  runOneTick,
  sliceBranchFor,
  slugify,
  _isInflightForTest,
  _resetInflightForTest,
  type AfkLoopDeps,
  type IssueRef,
  type LoopImplementArgs,
  type LoopReviewArgs,
  type TickOutcome,
} from "./afk-loop.ts";
import type { ImplementSpawnResult } from "./implement-spawn.ts";
import type { ReviewSpawnResult, Verdict } from "./review-spawn.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

const ISSUE: IssueRef = {
  number: 42,
  title: "Wire poller to issue cache",
  body: "Hook the snapshot into B10's seam.",
  labels: ["ready-for-agent", "enhancement"],
};

function okImpl(branch: string): ImplementSpawnResult {
  return {
    outcome: "ok",
    result: {
      branch,
      commitSha: "abc1234",
      verifyResult: { ok: true, output: "ok", exitCode: 0 },
    },
    exitCode: 0,
    wasAborted: false,
    assistantTail: "done",
    stderrTail: "",
  };
}
function verifyFailImpl(branch: string): ImplementSpawnResult {
  return {
    outcome: "ok",
    result: {
      branch,
      commitSha: "abc1234",
      verifyResult: { ok: false, output: "TYPE ERROR in foo.ts", exitCode: 2 },
    },
    exitCode: 0,
    wasAborted: false,
    assistantTail: "tried",
    stderrTail: "",
  };
}
function failImpl(
  outcome: ImplementSpawnResult["outcome"],
  reason = "boom",
): ImplementSpawnResult {
  return {
    outcome,
    exitCode: 1,
    wasAborted: outcome === "aborted",
    assistantTail: "partial",
    stderrTail: "err",
    reason,
  };
}
function okReview(verdict: Verdict, comments: string[] = []): ReviewSpawnResult {
  return {
    outcome: "ok",
    result: { verdict, comments },
    exitCode: 0,
    wasAborted: false,
    assistantTail: "",
    stderrTail: "",
  };
}
function failReview(
  outcome: ReviewSpawnResult["outcome"],
): ReviewSpawnResult {
  return {
    outcome,
    exitCode: 1,
    wasAborted: outcome === "aborted",
    assistantTail: "rev partial",
    stderrTail: "rev err",
    reason: "bad",
  };
}

type Call = { fn: string; args: any[] };

function makeDeps(overrides: Partial<AfkLoopDeps> = {}): {
  deps: AfkLoopDeps;
  calls: Call[];
  iterations: Map<number, number>;
} {
  const calls: Call[] = [];
  const rec =
    (fn: string) =>
    (...args: any[]) => {
      calls.push({ fn, args });
    };
  const iterations = new Map<number, number>();
  const deps: AfkLoopDeps = {
    pickIssue: async () => {
      calls.push({ fn: "pickIssue", args: [] });
      return ISSUE;
    },
    setState: async (issue, to) => {
      calls.push({ fn: "setState", args: [issue.number, to] });
    },
    createBranch: async (branch) => {
      calls.push({ fn: "createBranch", args: [branch] });
    },
    implementSpawn: async (args: LoopImplementArgs) => {
      calls.push({ fn: "implementSpawn", args: [args] });
      return okImpl(args.branch);
    },
    pushAndOpenPr: async (branch, title, body) => {
      calls.push({ fn: "pushAndOpenPr", args: [branch, title, body] });
      return { prNumber: 999 };
    },
    reviewSpawn: async (args: LoopReviewArgs) => {
      calls.push({ fn: "reviewSpawn", args: [args] });
      return okReview("approve");
    },
    postPrComments: async (pr, comments) => {
      calls.push({ fn: "postPrComments", args: [pr, comments] });
    },
    mergeAndClose: async (pr, issue) => {
      calls.push({ fn: "mergeAndClose", args: [pr, issue] });
    },
    applyHumanReviewLabel: async (issue) => {
      calls.push({ fn: "applyHumanReviewLabel", args: [issue.number] });
    },
    comment: async (issue, body) => {
      calls.push({ fn: "comment", args: [issue.number, body] });
    },
    loadIteration: async (n) => {
      calls.push({ fn: "loadIteration", args: [n] });
      return iterations.get(n) ?? 0;
    },
    bumpIteration: async (n) => {
      calls.push({ fn: "bumpIteration", args: [n] });
      const next = (iterations.get(n) ?? 0) + 1;
      iterations.set(n, next);
      return next;
    },
    iterationCap: 2,
    cwd: "/repo",
    trackBranch: "track/afk-loop",
    ...overrides,
  };
  return { deps, calls, iterations };
}

function fnSeq(calls: Call[]): string[] {
  return calls.map((c) => c.fn);
}

// ====================================================================
// Pure helpers
// ====================================================================

// slugify
check("slugify lowercases + dasherizes", slugify("Wire Poller TO Cache") === "wire-poller-to-cache");
check("slugify collapses runs", slugify("foo   bar---baz") === "foo-bar-baz");
check("slugify strips edge dashes", slugify("---hi---") === "hi");
check("slugify caps at 40 on word boundary", slugify("a-very-long-title-that-exceeds-forty-characters-by-a-mile").length <= 40);
check("slugify falls back to 'untitled' on all-non-alnum", slugify("!!!---") === "untitled");
check("slugify keeps digits", slugify("Issue 42: do thing") === "issue-42-do-thing");

// sliceBranchFor
check("sliceBranchFor uses slug + number", sliceBranchFor(ISSUE) === "slice/issue-42-wire-poller-to-issue-cache");

// composeTaskBrief
{
  const brief = composeTaskBrief(ISSUE);
  check("brief includes title + number", brief.includes("#42") && brief.includes("Wire poller to issue cache"));
  check("brief includes body", brief.includes("Hook the snapshot"));
  check("brief w/o followUp has no feedback section", !brief.includes("Reviewer feedback"));

  const brief2 = composeTaskBrief(ISSUE, ["fix this", "and that"]);
  check("brief w/ followUp adds feedback section", brief2.includes("Reviewer feedback from previous round"));
  check("brief w/ followUp bullets comments", brief2.includes("- fix this") && brief2.includes("- and that"));

  const brief3 = composeTaskBrief(ISSUE, []);
  check("brief w/ empty followUp has no feedback section", !brief3.includes("Reviewer feedback"));

  const empty = composeTaskBrief({ ...ISSUE, body: "" });
  check("brief tolerates empty body", empty.includes("(no body)"));
}

// composePrBody
{
  const body = composePrBody(ISSUE);
  check("PR body has Closes #N", body.startsWith("Closes #42"));
  check("PR body includes issue body", body.includes("Hook the snapshot"));
}

// formatters
{
  const vfc = formatVerifyFailComment("ERR: x undefined");
  check("verify-fail comment names the failure", vfc.includes("Verify gate failed"));
  check("verify-fail comment fences output", vfc.includes("```\nERR: x undefined\n```"));

  const ifc = formatImplementerFailComment("spawn_failed", "spawn errno", "asst", "stderrline");
  check("impl-fail names outcome", ifc.includes("`spawn_failed`"));
  check("impl-fail includes reason", ifc.includes("spawn errno"));
  check("impl-fail includes assistant tail", ifc.includes("asst"));
  check("impl-fail includes stderr tail", ifc.includes("stderrline"));

  const ifc2 = formatImplementerFailComment("aborted", undefined, "", "");
  check("impl-fail omits empty sections", !ifc2.includes("Reason:") && !ifc2.includes("Assistant tail"));

  const rfc = formatReviewerFailComment("bad_result_file", "bad shape", "rasst", "rerr");
  check("rev-fail names outcome", rfc.includes("`bad_result_file`"));
  check("rev-fail includes reason", rfc.includes("bad shape"));
  check("rev-fail includes assistant tail", rfc.includes("rasst"));
  check("rev-fail includes stderr tail", rfc.includes("rerr"));
}

// ====================================================================
// Reentrancy
// ====================================================================

{
  _resetInflightForTest();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { deps, calls } = makeDeps({
    pickIssue: async () => {
      calls.push({ fn: "pickIssue", args: [] });
      await gate;
      return null;
    },
  });
  const first = runOneTick(deps);
  check("inflight true while first in flight", _isInflightForTest());
  const second = await runOneTick(deps);
  check("second tick reentrancy-skipped", second.outcome === "skipped-reentrancy");
  // second must not have invoked any dep
  check("second tick did NOT call pickIssue again", calls.filter((c) => c.fn === "pickIssue").length === 1);
  release();
  const firstResult = await first;
  check("first tick eventually resolved", firstResult.outcome === "blocked-idle");
  check("inflight cleared after first resolves", !_isInflightForTest());

  // third tick after release should proceed
  const third = await runOneTick(deps);
  check("third tick (post-release) is NOT skipped", third.outcome !== "skipped-reentrancy");
}

// ====================================================================
// blocked-idle
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    pickIssue: async () => {
      calls.push({ fn: "pickIssue", args: [] });
      return null;
    },
  });
  const r = await runOneTick(deps);
  check("blocked-idle outcome on no pick", r.outcome === "blocked-idle");
  check("blocked-idle invokes no other deps", fnSeq(calls).join(",") === "pickIssue");
}

// ====================================================================
// Happy path: pick → implement(ok) → push → review(approve) → merge
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps();
  const r = await runOneTick(deps);
  check("happy: outcome merged", r.outcome === "merged");
  if (r.outcome === "merged") {
    check("happy: merged.issueNumber", r.issueNumber === 42);
    check("happy: merged.prNumber", r.prNumber === 999);
    check("happy: iterations === 0", r.iterations === 0);
  }
  const seq = fnSeq(calls);
  check(
    "happy: call sequence",
    seq.join(",") ===
      ["pickIssue","setState","createBranch","loadIteration","implementSpawn","pushAndOpenPr","reviewSpawn","mergeAndClose","setState"].join(","),
    seq.join(","),
  );
  // state transitions: in-progress then done
  const states = calls.filter((c) => c.fn === "setState").map((c) => c.args[1]);
  check("happy: states in-progress then done", states[0] === "in-progress" && states[1] === "done");
  // branch name
  const branchArg = calls.find((c) => c.fn === "createBranch")!.args[0];
  check("happy: branch name", branchArg === "slice/issue-42-wire-poller-to-issue-cache");
  // PR opened on track branch via reviewSpawn args
  const revArgs: LoopReviewArgs = calls.find((c) => c.fn === "reviewSpawn")!.args[0];
  check("happy: review baseBranch", revArgs.baseBranch === "track/afk-loop");
  check("happy: review prNumber", revArgs.prNumber === 999);
  check("happy: review sliceBranch", revArgs.sliceBranch === branchArg);
}

// ====================================================================
// Verify fail → escalate
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    implementSpawn: async (args) => {
      calls.push({ fn: "implementSpawn", args: [args] });
      return verifyFailImpl(args.branch);
    },
  });
  const r = await runOneTick(deps);
  check("verify-fail: escalated outcome", r.outcome === "escalated");
  if (r.outcome === "escalated") {
    check("verify-fail: stage = verify", r.stage === "verify");
    check("verify-fail: reason = verify-fail", r.reason === "verify-fail");
  }
  const fns = fnSeq(calls);
  check("verify-fail: no push, no review", !fns.includes("pushAndOpenPr") && !fns.includes("reviewSpawn"));
  check("verify-fail: posted a comment", fns.includes("comment"));
  check("verify-fail: applied human-review label", fns.includes("applyHumanReviewLabel"));
  const cmt = calls.find((c) => c.fn === "comment")!.args[1];
  check("verify-fail: comment includes verify output tail", cmt.includes("TYPE ERROR in foo.ts"));
}

// ====================================================================
// Implementer failure outcomes → escalate (all 4)
// ====================================================================

for (const outcome of ["spawn_failed", "no_result_file", "bad_result_file", "aborted"] as const) {
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    implementSpawn: async (args) => {
      calls.push({ fn: "implementSpawn", args: [args] });
      return failImpl(outcome, `reason for ${outcome}`);
    },
  });
  const r = await runOneTick(deps);
  check(`impl-fail[${outcome}]: escalated`, r.outcome === "escalated");
  if (r.outcome === "escalated") {
    check(`impl-fail[${outcome}]: stage = implement`, r.stage === "implement");
    check(`impl-fail[${outcome}]: reason names outcome`, r.reason === `implementer:${outcome}`);
  }
  const fns = fnSeq(calls);
  check(`impl-fail[${outcome}]: no push`, !fns.includes("pushAndOpenPr"));
  check(`impl-fail[${outcome}]: applied human-review label`, fns.includes("applyHumanReviewLabel"));
  const cmt = calls.find((c) => c.fn === "comment")!.args[1];
  check(`impl-fail[${outcome}]: comment includes outcome`, cmt.includes(outcome));
  check(`impl-fail[${outcome}]: comment includes reason`, cmt.includes(`reason for ${outcome}`));
}

// ====================================================================
// changes-requested → bounce → approve
// ====================================================================

{
  _resetInflightForTest();
  let implCalls = 0;
  let revCalls = 0;
  const { deps, calls } = makeDeps({
    implementSpawn: async (args) => {
      implCalls++;
      calls.push({ fn: "implementSpawn", args: [args] });
      return okImpl(args.branch);
    },
    reviewSpawn: async (args) => {
      revCalls++;
      calls.push({ fn: "reviewSpawn", args: [args] });
      if (revCalls === 1) return okReview("changes-requested", ["tighten the loop", "rename foo"]);
      return okReview("approve");
    },
  });
  const r = await runOneTick(deps);
  check("bounce: outcome merged", r.outcome === "merged");
  if (r.outcome === "merged") {
    check("bounce: iterations === 1", r.iterations === 1);
  }
  check("bounce: implementer called twice", implCalls === 2);
  check("bounce: reviewer called twice", revCalls === 2);
  // PR opened exactly once, reused on second round
  check("bounce: pushAndOpenPr called once", calls.filter((c) => c.fn === "pushAndOpenPr").length === 1);
  // postPrComments fired for the first verdict
  check("bounce: postPrComments fired", calls.some((c) => c.fn === "postPrComments"));
  // second implementer call carries follow-up
  const secondImplArgs: LoopImplementArgs = calls.filter((c) => c.fn === "implementSpawn")[1].args[0];
  check("bounce: second impl has followUpComments", Array.isArray(secondImplArgs.followUpComments) && secondImplArgs.followUpComments!.length === 2);
  check("bounce: second impl brief mentions reviewer feedback", secondImplArgs.taskBrief.includes("Reviewer feedback"));
  check("bounce: second impl brief includes the comments", secondImplArgs.taskBrief.includes("tighten the loop"));
  // merge ran exactly once
  check("bounce: mergeAndClose called once", calls.filter((c) => c.fn === "mergeAndClose").length === 1);
}

// ====================================================================
// Iteration cap → escalate
// cap=2 means: iter=0 ok bounce → iter=1 ok bounce → iter=2 escalates
// ====================================================================

{
  _resetInflightForTest();
  let revCalls = 0;
  const { deps, calls } = makeDeps({
    reviewSpawn: async (args) => {
      revCalls++;
      calls.push({ fn: "reviewSpawn", args: [args] });
      return okReview("changes-requested", [`round ${revCalls} note`]);
    },
  });
  const r = await runOneTick(deps);
  check("cap: escalated outcome", r.outcome === "escalated");
  if (r.outcome === "escalated") {
    check("cap: stage = cap", r.stage === "cap");
    check("cap: reason mentions cap", r.reason!.startsWith("cap-exceeded"));
  }
  check("cap: reviewer called cap+1 times (0,1,2 = 3 rounds)", revCalls === 3);
  // bumpIteration called exactly twice (after rounds 1 and 2; round 3 is the gate)
  check("cap: bumpIteration called twice", calls.filter((c) => c.fn === "bumpIteration").length === 2);
  // applied human-review label
  check("cap: applied human-review label", calls.some((c) => c.fn === "applyHumanReviewLabel"));
  // no merge
  check("cap: did NOT merge", !calls.some((c) => c.fn === "mergeAndClose"));
}

// ====================================================================
// Reviewer escalate verdict
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    reviewSpawn: async (args) => {
      calls.push({ fn: "reviewSpawn", args: [args] });
      return okReview("escalate", ["needs human eye"]);
    },
  });
  const r = await runOneTick(deps);
  check("rev-escalate: escalated outcome", r.outcome === "escalated");
  if (r.outcome === "escalated") {
    check("rev-escalate: stage = review", r.stage === "review");
    check("rev-escalate: reason = reviewer-escalate", r.reason === "reviewer-escalate");
  }
  check("rev-escalate: posted comments to PR", calls.some((c) => c.fn === "postPrComments"));
  check("rev-escalate: applied human-review label", calls.some((c) => c.fn === "applyHumanReviewLabel"));
  check("rev-escalate: did NOT merge", !calls.some((c) => c.fn === "mergeAndClose"));
}

// rev-escalate w/ empty comments → no postPrComments call
{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    reviewSpawn: async (args) => {
      calls.push({ fn: "reviewSpawn", args: [args] });
      return okReview("escalate", []);
    },
  });
  const r = await runOneTick(deps);
  check("rev-escalate-empty: escalated", r.outcome === "escalated");
  check("rev-escalate-empty: no postPrComments when comments []", !calls.some((c) => c.fn === "postPrComments"));
}

// ====================================================================
// Reviewer failure outcomes → escalate (all 4)
// ====================================================================

for (const outcome of ["spawn_failed", "no_result_file", "bad_result_file", "aborted"] as const) {
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    reviewSpawn: async (args) => {
      calls.push({ fn: "reviewSpawn", args: [args] });
      return failReview(outcome);
    },
  });
  const r = await runOneTick(deps);
  check(`rev-fail[${outcome}]: escalated`, r.outcome === "escalated");
  if (r.outcome === "escalated") {
    check(`rev-fail[${outcome}]: stage = review`, r.stage === "review");
    check(`rev-fail[${outcome}]: reason names outcome`, r.reason === `reviewer:${outcome}`);
  }
  check(`rev-fail[${outcome}]: applied human-review label`, calls.some((c) => c.fn === "applyHumanReviewLabel"));
  check(`rev-fail[${outcome}]: comment posted with outcome`, calls.some((c) => c.fn === "comment" && c.args[1].includes(outcome)));
}

// ====================================================================
// pickIssue throws → error outcome, no other dep called
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    pickIssue: async () => {
      calls.push({ fn: "pickIssue", args: [] });
      throw new Error("network down");
    },
  });
  const r = await runOneTick(deps);
  check("pickIssue throw: error outcome", r.outcome === "error");
  if (r.outcome === "error") {
    check("pickIssue throw: error mentions message", r.error.includes("network down"));
  }
  check("pickIssue throw: lock released", !_isInflightForTest());
}

// ====================================================================
// Dep throw mid-flight → error outcome with issueNumber, lock released
// ====================================================================

{
  _resetInflightForTest();
  const { deps, calls } = makeDeps({
    pushAndOpenPr: async () => {
      calls.push({ fn: "pushAndOpenPr", args: [] });
      throw new Error("gh auth required");
    },
  });
  const r = await runOneTick(deps);
  check("mid-throw: error outcome", r.outcome === "error");
  if (r.outcome === "error") {
    check("mid-throw: error has issueNumber", r.issueNumber === 42);
    check("mid-throw: error mentions gh auth", r.error.includes("gh auth required"));
  }
  check("mid-throw: lock released", !_isInflightForTest());
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
