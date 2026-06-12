/**
 * B8c — builder for the real AfkLoopDeps (index.ts wiring).
 *
 * Extracted from index.ts so the pure helpers can be unit-tested
 * and the dep-builder can be inspected independently.
 *
 * Pure helpers (exported + smoked):
 *   parsePrNumber   — parse the PR URL from `gh pr create` stdout
 *
 * The builder itself wires real gh/git/spawn calls and B8b's
 * iteration persistence. It is NOT called at module load time — only
 * when the user runs /flow-afk so the profile exists by then.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readProfile, type Profile } from "./profile.ts";
import { createGh, type Gh } from "./gh.ts";
import type { MutationRegistry } from "./mutation-registry.ts";
import { parseDependsOn, parseTrackParent } from "./flow-deps.ts";
import { implementSpawn, currentSpawnDepth } from "./implement-spawn.ts";
import { reviewSpawn } from "./review-spawn.ts";
import {
  loadIterationFromMap,
  bumpIteration as bumpIterEntry,
  resetIteration as resetIterEntry,
} from "./afk-iteration.ts";
import type { AfkLoopDeps, IssueRef } from "./afk-loop.ts";
import type { GhIssueRef } from "./gh.ts";

/* ------------------------------------------------------------------ */
/* Pure helpers (testable without I/O)                                 */
/* ------------------------------------------------------------------ */

/**
 * Extract a numeric PR number from `gh pr create` stdout.
 *
 * `gh pr create` prints the PR URL as the last (or only) non-empty
 * line, e.g.:
 *   https://github.com/owner/repo/pull/123
 *
 * Returns `null` if no PR number can be found.
 */
export function parsePrNumber(stdout: string): number | null {
  // Match /pull/<digits> anywhere in the output — handles trailing
  // newlines, extra lines from --verbose, etc.
  const match = stdout.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the track branch from a profile and a picked issue.
 *
 * v1: look for a `Tracked: #<N>` link in the issue body, then find the
 * corresponding track issue and derive `<prefix><slug>`. If no parent
 * is found, fall back to `<prefix>afk-loop` (the current dev track).
 *
 * This is pure only for the lookup step; the caller supplies the
 * pre-fetched parent issue if available.
 */
export function resolveTrackBranch(
  profile: Profile,
  parentIssue: { title: string } | null,
): string {
  const prefix = profile.track_branch_prefix;
  if (!parentIssue) return `${prefix}afk-loop`;
  // slug: lowercase, non-alnum → dash, collapse, strip edges, cap 40
  const slug = parentIssue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${prefix}${slug || "afk-loop"}`;
}

/**
 * Build the arg vector for `gh pr create`.
 * Exported for smoke assertions (arg-vector shape test).
 */
export function buildPrCreateArgs(opts: {
  base: string;
  head: string;
  title: string;
  body: string;
}): string[] {
  return [
    "pr",
    "create",
    "--base",
    opts.base,
    "--head",
    opts.head,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
}

/**
 * Build the arg vector for `gh pr merge`.
 * Exported for smoke assertions.
 */
export function buildPrMergeArgs(prNumber: number): string[] {
  return ["pr", "merge", String(prNumber), "--squash", "--delete-branch"];
}

/**
 * Build the arg vector for `gh issue close`.
 * Exported for smoke assertions.
 */
export function buildIssueCloseArgs(issueNumber: number, prNumber: number): string[] {
  return [
    "issue",
    "close",
    String(issueNumber),
    "-c",
    `Landed via #${prNumber}.`,
  ];
}

/* ------------------------------------------------------------------ */
/* composeComment (mirrors index.ts — kept here for the dep-builder)   */
/* ------------------------------------------------------------------ */

export function composeCommentWithDisclaimer(
  disclaimer: string,
  body: string,
): string {
  const trimmed = body.trimStart();
  if (trimmed.startsWith(disclaimer)) return body;
  return `${disclaimer}\n\n${body}`;
}

/* ------------------------------------------------------------------ */
/* Dep builder                                                          */
/* ------------------------------------------------------------------ */

export type BuildRealDepsOpts = {
  pi: ExtensionAPI;
  gh: Gh;
  mutationRegistry: MutationRegistry;
  /** computeAssignable from index.ts — passed in to avoid duplication. */
  computeAssignable: (
    opts: { trackParent?: number; signal?: AbortSignal },
    profile: Profile,
  ) => Promise<{
    assignable: GhIssueRef[];
    blocked: Array<{ issue: GhIssueRef; openDeps: number[] }>;
  }>;
  iterMap: Map<number, number>;
  cwd: string;
};

/**
 * Construct the real `AfkLoopDeps` from live pi/gh/git primitives.
 *
 * Profile is re-read on every dep call (via `getProfile()`) so that
 * a mid-session `flow setup --edit` is picked up without restarting.
 * The two constant fields (`iterationCap`, `trackBranch`) are computed
 * once at build time from the profile that was current at activation.
 *
 * Throws `ProfileError` at build time if the profile does not exist
 * (caller — `/flow-afk` handler — should catch and notify the user).
 */
export function buildRealDeps(
  opts: BuildRealDepsOpts,
  activationProfile: Profile,
): AfkLoopDeps {
  const { pi, gh, mutationRegistry, computeAssignable, iterMap, cwd } = opts;

  function getProfile(): Profile {
    return readProfile(cwd);
  }

  const deps: AfkLoopDeps = {
    async pickIssue(): Promise<IssueRef | null> {
      const profile = getProfile();
      const { assignable } = await computeAssignable({}, profile);
      if (assignable.length === 0) return null;
      const issue = assignable[0]!;
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      };
    },

    async setState(issue: IssueRef, to: string): Promise<void> {
      if (to === "done") {
        const profile = getProfile();
        const addLabel = profile.labels.state.needs_acceptance;
        const removeLabel = profile.labels.state.ready_for_agent;
        await gh.editIssueLabels(issue.number, {
          add: [addLabel],
          remove: [removeLabel],
        });
        mutationRegistry.recordIssueMutation(issue.number, addLabel);
        mutationRegistry.recordIssueMutation(issue.number, removeLabel);
      }
      // "in-progress" → no-op for v1 (issue stays ready-for-agent while
      // work is in flight; the widget shows status via other means).
    },

    async createBranch(branch: string): Promise<void> {
      const r = await pi.exec("git", ["checkout", "-b", branch]);
      if (r.code !== 0) {
        throw new Error(
          `createBranch: git checkout -b ${branch} failed (exit ${r.code}): ${r.stderr.trim()}`,
        );
      }
    },

    implementSpawn(args) {
      const profile = getProfile();
      return implementSpawn({
        issueNumber: args.issueNumber,
        taskBrief: args.taskBrief,
        branch: args.branch,
        verifyGate: profile.verify_gate,
        cwd,
        currentDepth: currentSpawnDepth() + 1,
      });
    },

    async pushAndOpenPr(
      branch: string,
      title: string,
      body: string,
    ): Promise<{ prNumber: number }> {
      // Push branch to origin.
      const pushR = await pi.exec("git", ["push", "-u", "origin", branch]);
      if (pushR.code !== 0) {
        throw new Error(
          `pushAndOpenPr: git push failed (exit ${pushR.code}): ${pushR.stderr.trim()}`,
        );
      }

      // Create PR against the track branch.
      const ghArgs = buildPrCreateArgs({
        base: deps.trackBranch,
        head: branch,
        title,
        body,
      });
      const prR = await pi.exec("gh", ghArgs);
      if (prR.code !== 0) {
        throw new Error(
          `pushAndOpenPr: gh pr create failed (exit ${prR.code}): ${prR.stderr.trim()}`,
        );
      }
      const prNumber = parsePrNumber(prR.stdout);
      if (prNumber === null) {
        throw new Error(
          `pushAndOpenPr: could not parse PR number from gh output: ${prR.stdout.trim()}`,
        );
      }
      return { prNumber };
    },

    reviewSpawn(args) {
      const profile = getProfile();
      return reviewSpawn({
        issueNumber: args.issueNumber,
        sliceBranch: args.sliceBranch,
        baseBranch: args.baseBranch,
        prNumber: args.prNumber,
        sliceBrief: args.sliceBrief,
        reviewerCommand: profile.reviewer_command,
        cwd,
        currentDepth: currentSpawnDepth() + 1,
      });
    },

    async postPrComments(prNumber: number, comments: string[]): Promise<void> {
      // Join multiple comments into one gh call to minimise API calls.
      const body = comments.join("\n\n---\n\n");
      const r = await pi.exec("gh", [
        "pr",
        "comment",
        String(prNumber),
        "--body",
        body,
      ]);
      if (r.code !== 0) {
        throw new Error(
          `postPrComments: gh pr comment ${prNumber} failed (exit ${r.code}): ${r.stderr.trim()}`,
        );
      }
    },

    async mergeAndClose(prNumber: number, issueNumber: number): Promise<void> {
      const mergeArgs = buildPrMergeArgs(prNumber);
      const mergeR = await pi.exec("gh", mergeArgs);
      if (mergeR.code !== 0) {
        throw new Error(
          `mergeAndClose: gh pr merge ${prNumber} failed (exit ${mergeR.code}): ${mergeR.stderr.trim()}`,
        );
      }
      const closeArgs = buildIssueCloseArgs(issueNumber, prNumber);
      const closeR = await pi.exec("gh", closeArgs);
      if (closeR.code !== 0) {
        throw new Error(
          `mergeAndClose: gh issue close ${issueNumber} failed (exit ${closeR.code}): ${closeR.stderr.trim()}`,
        );
      }
    },

    async applyHumanReviewLabel(issue: IssueRef): Promise<void> {
      const label = getProfile().labels.review.human;
      await gh.editIssueLabels(issue.number, { add: [label] });
      mutationRegistry.recordIssueMutation(issue.number, label);
    },

    async comment(issue: IssueRef, body: string): Promise<void> {
      const profile = getProfile();
      const composed = composeCommentWithDisclaimer(profile.ai_disclaimer, body);
      await gh.commentOnIssue(issue.number, composed);
    },

    async loadIteration(issueNumber: number): Promise<number> {
      return loadIterationFromMap(iterMap, issueNumber);
    },

    async bumpIteration(issueNumber: number): Promise<number> {
      return bumpIterEntry(
        async (type, payload) => {
          // pi.appendEntry may be sync or fire-and-forget; wrap in Promise.
          (pi as { appendEntry?: (t: string, p: unknown) => void }).appendEntry?.(
            type,
            payload,
          );
        },
        iterMap,
        issueNumber,
      );
    },

    /** Iteration cap from the activation-time profile; constant for a run. */
    iterationCap: activationProfile.reviewer_iteration_cap,

    cwd,

    /**
     * Track branch for v1: derived at activation time from the profile
     * prefix + the current track name ("afk-loop"). Issue-level parent
     * lookup is a v2 enhancement.
     */
    trackBranch: `${activationProfile.track_branch_prefix}afk-loop`,
  };

  return deps;
}

/**
 * Convenience: call `resetIteration` for an issue after merge or escalation.
 * Wired by the B8c ticker wrapper around `runOneTick` outcomes.
 */
export async function onTickOutcomeReset(
  pi: ExtensionAPI,
  iterMap: Map<number, number>,
  issueNumber: number,
): Promise<void> {
  await resetIterEntry(
    async (type, payload) => {
      (pi as { appendEntry?: (t: string, p: unknown) => void }).appendEntry?.(
        type,
        payload,
      );
    },
    iterMap,
    issueNumber,
  );
}
