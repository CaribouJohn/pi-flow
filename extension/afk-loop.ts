/**
 * AFK loop body — the pure, fully-DI'd state graph from DESIGN.md §Loop.
 *
 * This module is import-only deterministic: no `gh`, no git, no `spawnPi`
 * reach the disk. All side effects flow through the `AfkLoopDeps`
 * interface so the smoke can drive every branch from a JS object.
 *
 * Wiring of real deps + the stub-onTick replacement lives in B8c
 * (extension/index.ts). Iteration count persistence lives in B8b.
 *
 * Reentrancy: a module-scoped Promise lock means that if the AFK
 * ticker fires while a previous tick is still in flight, the second
 * call resolves immediately as `{ outcome: "skipped-reentrancy" }`
 * without invoking any dep. Slices take minutes; ticks fire seconds.
 */

import type { ImplementSpawnResult } from "./implement-spawn.ts";
import type { ReviewSpawnResult, Verdict } from "./review-spawn.ts";

/** Minimal issue projection the loop needs. */
export type IssueRef = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

/** Args the loop hands the implementer DI seam. */
export type LoopImplementArgs = {
  issueNumber: number;
  branch: string;
  taskBrief: string;
  /** Reviewer comments from a prior round, when bouncing. */
  followUpComments?: string[];
};

/** Args the loop hands the reviewer DI seam. */
export type LoopReviewArgs = {
  issueNumber: number;
  sliceBranch: string;
  baseBranch: string;
  prNumber: number;
  sliceBrief: string;
};

/**
 * Everything the loop body needs to be hermetic.
 *
 * B8c constructs this from real `gh`/git/spawn primitives. The smoke
 * constructs it from a JS object whose every method records calls.
 */
export interface AfkLoopDeps {
  pickIssue(): Promise<IssueRef | null>;
  setState(issue: IssueRef, to: string): Promise<void>;
  createBranch(branch: string): Promise<void>;
  implementSpawn(args: LoopImplementArgs): Promise<ImplementSpawnResult>;
  pushAndOpenPr(
    branch: string,
    title: string,
    body: string,
  ): Promise<{ prNumber: number }>;
  reviewSpawn(args: LoopReviewArgs): Promise<ReviewSpawnResult>;
  postPrComments(prNumber: number, comments: string[]): Promise<void>;
  mergeAndClose(prNumber: number, issueNumber: number): Promise<void>;
  applyHumanReviewLabel(issue: IssueRef): Promise<void>;
  comment(issue: IssueRef, body: string): Promise<void>;
  loadIteration(issueNumber: number): Promise<number>;
  bumpIteration(issueNumber: number): Promise<number>;
  iterationCap: number;
  cwd: string;
  trackBranch: string;
}

export type TickOutcome =
  | { outcome: "blocked-idle" }
  | { outcome: "skipped-reentrancy" }
  | {
      outcome: "merged";
      issueNumber: number;
      prNumber: number;
      iterations: number;
    }
  | {
      outcome: "escalated";
      issueNumber: number;
      reason: string;
      stage: "implement" | "verify" | "review" | "cap";
    }
  | { outcome: "error"; issueNumber?: number; error: string };

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for smoke)                                  */
/* ------------------------------------------------------------------ */

/**
 * Slugify an issue title for use in a branch name. Lower-cases,
 * collapses non-alphanumerics to `-`, trims, caps at 40 chars on a
 * word boundary where possible.
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= 40) return base || "untitled";
  const truncated = base.slice(0, 40);
  const lastDash = truncated.lastIndexOf("-");
  return lastDash > 20 ? truncated.slice(0, lastDash) : truncated;
}

/** Branch name for a slice: `slice/issue-NNN-slug`. */
export function sliceBranchFor(issue: IssueRef): string {
  return `slice/issue-${issue.number}-${slugify(issue.title)}`;
}

/** Compose the implementer's task brief from the issue + optional follow-up. */
export function composeTaskBrief(
  issue: IssueRef,
  followUpComments?: string[],
): string {
  const head = `Implement issue #${issue.number}: ${issue.title}\n\n${issue.body || "(no body)"}`;
  if (!followUpComments || followUpComments.length === 0) return head;
  const bullets = followUpComments.map((c) => `- ${c}`).join("\n");
  return `${head}\n\n## Reviewer feedback from previous round\n\nAddress each of the following comments:\n\n${bullets}`;
}

/** Compose the PR body for a slice. `Closes #N` is for default-branch hygiene. */
export function composePrBody(issue: IssueRef): string {
  return `Closes #${issue.number}\n\n${issue.body || ""}`.trim();
}

/** Format a verify-fail comment from the implementer's verify result. */
export function formatVerifyFailComment(verifyOutputTail: string): string {
  return `Verify gate failed. Tail of output:\n\n\`\`\`\n${verifyOutputTail}\n\`\`\``;
}

/** Format an implementer-failure escalation comment. */
export function formatImplementerFailComment(
  outcome: string,
  reason: string | undefined,
  assistantTail: string,
  stderrTail: string,
): string {
  const parts = [`Implementer sub-session failed: \`${outcome}\`.`];
  if (reason) parts.push(`Reason: ${reason}`);
  if (assistantTail) parts.push(`Assistant tail:\n\n\`\`\`\n${assistantTail}\n\`\`\``);
  if (stderrTail) parts.push(`Stderr tail:\n\n\`\`\`\n${stderrTail}\n\`\`\``);
  return parts.join("\n\n");
}

/** Format a reviewer-failure escalation comment. */
export function formatReviewerFailComment(
  outcome: string,
  reason: string | undefined,
  assistantTail: string,
  stderrTail: string,
): string {
  const parts = [`Reviewer sub-session failed: \`${outcome}\`.`];
  if (reason) parts.push(`Reason: ${reason}`);
  if (assistantTail) parts.push(`Assistant tail:\n\n\`\`\`\n${assistantTail}\n\`\`\``);
  if (stderrTail) parts.push(`Stderr tail:\n\n\`\`\`\n${stderrTail}\n\`\`\``);
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Reentrancy lock                                                    */
/* ------------------------------------------------------------------ */

let inflight: Promise<TickOutcome> | null = null;

/** Test-only: clear the reentrancy lock. */
export function _resetInflightForTest(): void {
  inflight = null;
}

/** Test-only: peek at whether the lock is held. */
export function _isInflightForTest(): boolean {
  return inflight !== null;
}

/* ------------------------------------------------------------------ */
/* Loop body                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run one AFK loop tick. Reentrancy-safe: if a tick is already in
 * flight, returns `{ outcome: "skipped-reentrancy" }` immediately
 * without touching deps.
 */
export async function runOneTick(deps: AfkLoopDeps): Promise<TickOutcome> {
  if (inflight !== null) {
    return { outcome: "skipped-reentrancy" };
  }
  const work = runOneTickInner(deps).finally(() => {
    inflight = null;
  });
  inflight = work;
  return work;
}

async function runOneTickInner(deps: AfkLoopDeps): Promise<TickOutcome> {
  let issue: IssueRef | null;
  try {
    issue = await deps.pickIssue();
  } catch (err) {
    return { outcome: "error", error: `pickIssue threw: ${stringifyErr(err)}` };
  }
  if (!issue) return { outcome: "blocked-idle" };

  try {
    return await runForIssue(deps, issue);
  } catch (err) {
    return {
      outcome: "error",
      issueNumber: issue.number,
      error: `loop threw: ${stringifyErr(err)}`,
    };
  }
}

async function runForIssue(
  deps: AfkLoopDeps,
  issue: IssueRef,
): Promise<TickOutcome> {
  await deps.setState(issue, "in-progress");

  const branch = sliceBranchFor(issue);
  await deps.createBranch(branch);

  let iter = await deps.loadIteration(issue.number);
  let followUp: string[] | undefined;
  let prNumber: number | undefined;

  // implement → (verify → push/PR) → review → (merge | bounce | escalate)
  while (true) {
    const implResult = await deps.implementSpawn({
      issueNumber: issue.number,
      branch,
      taskBrief: composeTaskBrief(issue, followUp),
      followUpComments: followUp,
    });

    if (implResult.outcome !== "ok") {
      const body = formatImplementerFailComment(
        implResult.outcome,
        implResult.reason,
        implResult.assistantTail,
        implResult.stderrTail,
      );
      await deps.comment(issue, body);
      await deps.applyHumanReviewLabel(issue);
      return {
        outcome: "escalated",
        issueNumber: issue.number,
        reason: `implementer:${implResult.outcome}`,
        stage: "implement",
      };
    }

    const verify = implResult.result?.verifyResult;
    if (!verify || !verify.ok) {
      const tail = verify?.output ?? "(no verify output)";
      await deps.comment(issue, formatVerifyFailComment(tail));
      await deps.applyHumanReviewLabel(issue);
      return {
        outcome: "escalated",
        issueNumber: issue.number,
        reason: "verify-fail",
        stage: "verify",
      };
    }

    // First successful implementer round opens the PR; later rounds reuse it.
    if (prNumber === undefined) {
      const opened = await deps.pushAndOpenPr(
        branch,
        `${issue.title} (Closes #${issue.number})`,
        composePrBody(issue),
      );
      prNumber = opened.prNumber;
    }

    const review = await deps.reviewSpawn({
      issueNumber: issue.number,
      sliceBranch: branch,
      baseBranch: deps.trackBranch,
      prNumber,
      sliceBrief: composeTaskBrief(issue),
    });

    if (review.outcome !== "ok" || !review.result) {
      const body = formatReviewerFailComment(
        review.outcome,
        review.reason,
        review.assistantTail,
        review.stderrTail,
      );
      await deps.comment(issue, body);
      await deps.applyHumanReviewLabel(issue);
      return {
        outcome: "escalated",
        issueNumber: issue.number,
        reason: `reviewer:${review.outcome}`,
        stage: "review",
      };
    }

    const verdict: Verdict = review.result.verdict;
    const comments = review.result.comments;

    if (verdict === "approve") {
      await deps.mergeAndClose(prNumber, issue.number);
      await deps.setState(issue, "done");
      return {
        outcome: "merged",
        issueNumber: issue.number,
        prNumber,
        iterations: iter,
      };
    }

    if (verdict === "escalate") {
      if (comments.length > 0) await deps.postPrComments(prNumber, comments);
      await deps.applyHumanReviewLabel(issue);
      return {
        outcome: "escalated",
        issueNumber: issue.number,
        reason: "reviewer-escalate",
        stage: "review",
      };
    }

    // changes-requested
    if (iter >= deps.iterationCap) {
      if (comments.length > 0) await deps.postPrComments(prNumber, comments);
      await deps.applyHumanReviewLabel(issue);
      return {
        outcome: "escalated",
        issueNumber: issue.number,
        reason: `cap-exceeded:${iter}>=${deps.iterationCap}`,
        stage: "cap",
      };
    }

    if (comments.length > 0) await deps.postPrComments(prNumber, comments);
    iter = await deps.bumpIteration(issue.number);
    followUp = comments;
    // loop back to implement with follow-up
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
