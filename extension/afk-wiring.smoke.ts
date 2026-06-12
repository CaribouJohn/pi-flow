/**
 * Smoke for afk-wiring. Run with:
 *   bun extension/afk-wiring.smoke.ts
 *
 * Tests pure helpers and arg-vector shapes for the real dep builder.
 * Does NOT call pi.exec / gh CLI.
 */

import {
  buildIssueCloseArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildRealDeps,
  composeCommentWithDisclaimer,
  onTickOutcomeReset,
  parsePrNumber,
  resolveTrackBranch,
  type BuildRealDepsOpts,
} from "./afk-wiring.ts";
import type { Profile } from "./profile.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// ====================================================================
// parsePrNumber
// ====================================================================

// standard gh pr create output
check(
  "parsePrNumber: full URL",
  parsePrNumber("https://github.com/CaribouJohn/pi-flow/pull/123") === 123,
);
check(
  "parsePrNumber: URL with trailing newline",
  parsePrNumber("https://github.com/owner/repo/pull/99\n") === 99,
);
check(
  "parsePrNumber: URL after extra text",
  parsePrNumber("Creating pull request\nhttps://github.com/owner/repo/pull/7\n") === 7,
);
check(
  "parsePrNumber: verbose with body line",
  parsePrNumber("  body: Closes #5\nhttps://github.com/o/r/pull/42\n") === 42,
);
check("parsePrNumber: returns null for empty string", parsePrNumber("") === null);
check(
  "parsePrNumber: returns null for no URL",
  parsePrNumber("error: authentication required") === null,
);
check("parsePrNumber: returns null for pull/0", parsePrNumber("/pull/0") === null);
check(
  "parsePrNumber: large PR number",
  parsePrNumber("https://github.com/o/r/pull/12345") === 12345,
);

// ====================================================================
// resolveTrackBranch
// ====================================================================

const baseProfile = {
  track_branch_prefix: "track/",
} as unknown as Profile;

check(
  "resolveTrackBranch: no parent → afk-loop fallback",
  resolveTrackBranch(baseProfile, null) === "track/afk-loop",
);
check(
  "resolveTrackBranch: parent title slugified",
  resolveTrackBranch(baseProfile, { title: "Wire poller to loop" }) ===
    "track/wire-poller-to-loop",
);
check(
  "resolveTrackBranch: parent title caps at 40",
  resolveTrackBranch(baseProfile, {
    title: "A very long title that exceeds forty characters by a margin",
  }).length <= "track/".length + 40,
);
check(
  "resolveTrackBranch: empty parent title → afk-loop fallback",
  resolveTrackBranch(baseProfile, { title: "!!! ---" }) === "track/afk-loop",
);

// ====================================================================
// buildPrCreateArgs
// ====================================================================

{
  const args = buildPrCreateArgs({
    base: "track/afk-loop",
    head: "slice/issue-42-foo",
    title: "Fix thing (Closes #42)",
    body: "Closes #42\n\nbody text",
  });
  check("buildPrCreateArgs: starts with pr create", args[0] === "pr" && args[1] === "create");
  const baseIdx = args.indexOf("--base");
  check("buildPrCreateArgs: --base value", baseIdx !== -1 && args[baseIdx + 1] === "track/afk-loop");
  const headIdx = args.indexOf("--head");
  check("buildPrCreateArgs: --head value", headIdx !== -1 && args[headIdx + 1] === "slice/issue-42-foo");
  const titleIdx = args.indexOf("--title");
  check("buildPrCreateArgs: --title value", titleIdx !== -1 && args[titleIdx + 1] === "Fix thing (Closes #42)");
  const bodyIdx = args.indexOf("--body");
  check("buildPrCreateArgs: --body value", bodyIdx !== -1 && args[bodyIdx + 1] === "Closes #42\n\nbody text");
}

// ====================================================================
// buildPrMergeArgs
// ====================================================================

{
  const args = buildPrMergeArgs(99);
  check("buildPrMergeArgs: starts with pr merge", args[0] === "pr" && args[1] === "merge");
  check("buildPrMergeArgs: pr number", args[2] === "99");
  check("buildPrMergeArgs: --squash flag", args.includes("--squash"));
  check("buildPrMergeArgs: --delete-branch flag", args.includes("--delete-branch"));
}

// ====================================================================
// buildIssueCloseArgs
// ====================================================================

{
  const args = buildIssueCloseArgs(42, 99);
  check("buildIssueCloseArgs: starts with issue close", args[0] === "issue" && args[1] === "close");
  check("buildIssueCloseArgs: issue number", args[2] === "42");
  const cIdx = args.indexOf("-c");
  check("buildIssueCloseArgs: -c comment includes PR ref", cIdx !== -1 && args[cIdx + 1]!.includes("#99"));
}

// ====================================================================
// composeCommentWithDisclaimer
// ====================================================================

{
  const disclaimer = "🤖 Posted by pi-flow";
  check(
    "composeComment: prepends disclaimer",
    composeCommentWithDisclaimer(disclaimer, "hello").startsWith(disclaimer),
  );
  check(
    "composeComment: idempotent if already starts with disclaimer",
    composeCommentWithDisclaimer(disclaimer, `${disclaimer}\n\nhello`) ===
      `${disclaimer}\n\nhello`,
  );
  check(
    "composeComment: blank line between disclaimer and body",
    composeCommentWithDisclaimer(disclaimer, "hello").includes("\n\nhello"),
  );
}

// ====================================================================
// buildRealDeps — structural shape (all required keys present)
// ====================================================================

{
  type ExecResult = { stdout: string; stderr: string; code: number };

  // Minimal mock pi
  const appendedEntries: { type: string; payload: unknown }[] = [];
  const mockPi = {
    exec: async (_cmd: string, _args: string[]): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      code: 0,
    }),
    appendEntry: (type: string, payload: unknown) => {
      appendedEntries.push({ type, payload });
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

  const mockGh = {
    editIssueLabels: async () => {},
    commentOnIssue: async () => {},
    listIssues: async () => [],
    viewIssue: async () => ({ number: 0, title: "", state: "OPEN" as const, labels: [], body: "", updatedAt: "" }),
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
  };

  const mockRegistry = {
    record: () => ({ expiresAt: 0 }),
    recordIssueMutation: () => {},
    isMutation: () => false,
    isIssueMutation: () => false,
    prune: () => {},
  };

  const mockComputeAssignable = async () => ({ assignable: [], blocked: [] });
  const iterMap = new Map<number, number>();

  const activationProfile: Profile = {
    tracker: "github",
    repo: "owner/repo",
    default_branch: "main",
    track_branch_prefix: "track/",
    verify_gate: "echo ok",
    in_situ_harness: "",
    reviewer_command: "/code-review",
    reviewer_iteration_cap: 2,
    poll_cadence_seconds: 30,
    ai_disclaimer: "🤖 bot",
    labels: {
      category: [],
      state: {
        needs_triage: "needs-triage",
        needs_info: "needs-info",
        needs_grilling: "needs-grilling",
        needs_slicing: "needs-slicing",
        needs_plan_review: "needs-plan-review",
        tracking: "tracking",
        ready_for_agent: "ready-for-agent",
        ready_for_human: "ready-for-human",
        needs_acceptance: "needs-acceptance",
        wontfix: "wontfix",
      },
      effort: { low: "effort:low", medium: "effort:medium", high: "effort:high" },
      review: { agent: "review:agent", human: "review:human" },
    },
    body: "",
  };

  const buildOpts: BuildRealDepsOpts = {
    pi: mockPi,
    gh: mockGh as any,
    mutationRegistry: mockRegistry as any,
    computeAssignable: mockComputeAssignable as any,
    iterMap,
    cwd: process.cwd(),
  };

  // buildRealDeps will call readProfile(cwd) inside each dep lazily,
  // but the constant fields are set from activationProfile.
  // Since readProfile might throw in a test env (no .pi/flow.profile.md),
  // we only test the shape (constant fields) and pure arg-vector calls.

  const deps = buildRealDeps(buildOpts, activationProfile);

  // Structural shape
  const requiredKeys: Array<keyof import("./afk-loop.ts").AfkLoopDeps> = [
    "pickIssue", "setState", "createBranch", "implementSpawn",
    "pushAndOpenPr", "reviewSpawn", "postPrComments", "mergeAndClose",
    "applyHumanReviewLabel", "comment", "loadIteration", "bumpIteration",
    "iterationCap", "cwd", "trackBranch",
  ];
  for (const key of requiredKeys) {
    check(`buildRealDeps: has ${key}`, key in deps);
  }

  // Constant fields derived from activation profile
  check("buildRealDeps: iterationCap from profile", deps.iterationCap === 2);
  check("buildRealDeps: trackBranch from profile", deps.trackBranch === "track/afk-loop");
  check("buildRealDeps: cwd correct", deps.cwd === process.cwd());

  // loadIteration returns 0 for unknown issue
  check("buildRealDeps: loadIteration 0 for new", await deps.loadIteration(99) === 0);

  // bumpIteration increments the map and appends an entry
  const bumped = await deps.bumpIteration(42);
  check("buildRealDeps: bumpIteration returns 1", bumped === 1);
  check("buildRealDeps: bumpIteration updates iterMap", iterMap.get(42) === 1);
  check(
    "buildRealDeps: bumpIteration appended entry",
    appendedEntries.some((e) => e.type === "pi-flow:afk-iteration"),
  );

  // createBranch → pi.exec("git", ["checkout", "-b", ...])
  const execCalls: { cmd: string; args: string[] }[] = [];
  const piWithCapture = {
    ...mockPi,
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const depsWithCapture = buildRealDeps({ ...buildOpts, pi: piWithCapture }, activationProfile);
  await depsWithCapture.createBranch("slice/test-branch");
  check(
    "createBranch: calls git checkout -b",
    execCalls.some(
      (c) =>
        c.cmd === "git" &&
        c.args[0] === "checkout" &&
        c.args[1] === "-b" &&
        c.args[2] === "slice/test-branch",
    ),
  );

  // mergeAndClose → gh pr merge + gh issue close
  execCalls.length = 0;
  const piForMerge = {
    ...mockPi,
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const depsForMerge = buildRealDeps({ ...buildOpts, pi: piForMerge }, activationProfile);
  await depsForMerge.mergeAndClose(99, 42);
  check(
    "mergeAndClose: calls gh pr merge",
    execCalls.some(
      (c) =>
        c.cmd === "gh" &&
        c.args.includes("merge") &&
        c.args.includes("99") &&
        c.args.includes("--squash"),
    ),
  );
  check(
    "mergeAndClose: calls gh issue close",
    execCalls.some(
      (c) =>
        c.cmd === "gh" &&
        c.args.includes("close") &&
        c.args.includes("42") &&
        c.args.includes("-c"),
    ),
  );

  // postPrComments joins with separator and calls gh pr comment
  execCalls.length = 0;
  const piForComment = {
    ...mockPi,
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const depsForComment = buildRealDeps({ ...buildOpts, pi: piForComment }, activationProfile);
  await depsForComment.postPrComments(99, ["comment A", "comment B"]);
  const prCommentCall = execCalls.find(
    (c) => c.cmd === "gh" && c.args.includes("comment"),
  );
  check("postPrComments: calls gh pr comment", prCommentCall !== undefined);
  const bodyArg = prCommentCall?.args[prCommentCall.args.indexOf("--body") + 1] ?? "";
  check("postPrComments: joined body contains both comments", bodyArg.includes("comment A") && bodyArg.includes("comment B"));
}

// ====================================================================
// onTickOutcomeReset
// ====================================================================

{
  const appendedEntries2: { type: string; payload: unknown }[] = [];
  const mockPi2 = {
    appendEntry: (type: string, payload: unknown) => {
      appendedEntries2.push({ type, payload });
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const iterMap2 = new Map([[42, 3]]);
  await onTickOutcomeReset(mockPi2, iterMap2, 42);
  check("onTickOutcomeReset: zeroes map", iterMap2.get(42) === 0);
  check(
    "onTickOutcomeReset: appended reset entry",
    appendedEntries2.some(
      (e) =>
        e.type === "pi-flow:afk-iteration" &&
        (e.payload as any).kind === "reset" &&
        (e.payload as any).issueNumber === 42,
    ),
  );
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
