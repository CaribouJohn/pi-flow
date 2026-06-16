import type { ForgePort, MainProtection, PullRequest, Verdict } from "@pi-flow/flow-engine";
import { $ } from "bun";

/**
 * Git + GitHub-forge implementation of the engine's {@link ForgePort}, scoped so
 * it can never merge the default branch (invariant #1/#6). Git operations run in
 * a local clone (`workdir`); forge operations use `gh`. Commands run through an
 * injectable {@link CmdRunner} so the adapter is unit-testable without git/gh.
 *
 * Review state is recorded as machine-readable **marker comments** on the PR
 * rather than GitHub PR reviews: the autonomous reviewer runs as the same
 * `flow-bot` principal that authored the PR, and GitHub forbids approving your
 * own PR. The marker (a hidden HTML comment) is the source of truth the engine
 * reads back. (When #87 lands, the agent reviewer's verdict flows through here.)
 */

/** Runs a command in an optional cwd and returns stdout. */
export type CmdRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

const realRunner: CmdRunner = async (cmd, args, opts) => {
  const proc = opts?.cwd ? $`${cmd} ${args}`.cwd(opts.cwd) : $`${cmd} ${args}`;
  return await proc.text();
};

const MARKER = "flow-review";

export interface GitForgeOptions {
  repo: string;
  /** A local clone of `repo` with `origin` set; git ops run here. */
  workdir: string;
  /** The repo's default branch — the adapter refuses to merge into it. */
  defaultBranch: string;
  run?: CmdRunner;
}

/** Deterministic slice branch name (the profile's `slice/<n>` shape). */
export function sliceBranch(sliceId: number): string {
  return `slice/${sliceId}`;
}

export class GitForgeAdapter implements ForgePort {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly defaultBranch: string;
  private readonly run: CmdRunner;

  constructor(opts: GitForgeOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.defaultBranch = opts.defaultBranch;
    this.run = opts.run ?? realRunner;
  }

  private git(args: string[]): Promise<string> {
    return this.run("git", args, { cwd: this.workdir });
  }
  private gh(args: string[]): Promise<string> {
    return this.run("gh", args);
  }

  /** S0 — merge the default branch into the track branch (merge, not rebase). */
  async driftRefresh(trackBranch: string): Promise<void> {
    await this.git(["fetch", "origin"]);
    // Sync the local track branch to origin (the source of truth — slice merges
    // land on origin via `gh`, so the local branch goes stale and would push
    // non-fast-forward). `-f -B` resets/recreates it from origin, discarding any
    // leftover local state in this scratch workdir.
    await this.git(["checkout", "-f", "-B", trackBranch, `origin/${trackBranch}`]);
    try {
      await this.git(["merge", `origin/${this.defaultBranch}`, "--no-edit"]);
    } catch (err) {
      // Recover the workdir so a conflict surfaces as a clean failure (the
      // engine parks it, SPEC §8.7) instead of leaving it stuck mid-merge.
      await this.git(["merge", "--abort"]).catch(() => {});
      throw err;
    }
    await this.git(["push", "origin", trackBranch]);
  }

  async getSliceBranch(sliceId: number): Promise<string | null> {
    const branch = sliceBranch(sliceId);
    const out = await this.git(["ls-remote", "--heads", "origin", branch]);
    return out.trim().length > 0 ? branch : null;
  }

  async getSlicePr(sliceId: number): Promise<PullRequest | null> {
    const head = sliceBranch(sliceId);
    const openOut = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--head",
      head,
      "--state",
      "open",
      "--json",
      "number,baseRefName,comments",
    ]);
    const openPrs = JSON.parse(openOut) as GhPr[];
    if (openPrs[0] !== undefined) return prFromMarkers(openPrs[0]);

    // §8.8 — also detect a PR that was merged outside the loop so the
    // orchestrator can close the slice instead of re-implementing it.
    const mergedOut = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--head",
      head,
      "--state",
      "merged",
      "--json",
      "number,baseRefName,comments",
    ]);
    const mergedPrs = JSON.parse(mergedOut) as GhPr[];
    const merged = mergedPrs[0];
    if (merged !== undefined) {
      return {
        number: merged.number,
        base: merged.baseRefName,
        status: "merged",
        reviewAttempts: 0,
      };
    }

    return null;
  }

  /**
   * Create the slice branch off the track branch (S2), or reuse an existing one.
   *
   * Idempotent (§8.8): a slice branch may already carry prior, *unpushed* work
   * from a run that parked before the PR was pushed (e.g. a red verify gate on
   * the first implement attempt). Reuse it — NEVER `-B`-reset it, which would
   * silently destroy that committed work and then trip the "no changes" guard.
   * Only the genuinely-new case branches fresh off the track branch. Not pushed
   * until openPr.
   */
  async createSliceBranch(sliceId: number, fromBranch: string): Promise<string> {
    const branch = sliceBranch(sliceId);
    await this.git(["fetch", "origin"]);
    const exists = (await this.git(["branch", "--list", branch])).trim().length > 0;
    if (exists) {
      await this.git(["checkout", branch]);
    } else {
      // Base the new slice off the *authoritative* origin track, not the local
      // track branch — which may be stale if a sibling slice squash-merged into
      // origin earlier in this same run (the local branch is only synced at S0,
      // once per run). Branching off `origin/<track>` keeps sequential slices
      // stacked on each other and avoids an avoidable merge-conflict park (#151).
      await this.git(["checkout", "-b", branch, `origin/${fromBranch}`]);
    }
    return branch;
  }

  /** Push the slice branch's latest commits to origin (S6a re-implement). */
  async pushSlice(sliceId: number): Promise<void> {
    await this.git(["push", "origin", sliceBranch(sliceId)]);
  }

  /**
   * Merge the track branch into the slice branch and push (S7 pre-merge), so a
   * slice that went stale while siblings merged this run can still merge. On
   * conflict, abort (leaving the workdir clean) and return false → the slice
   * parks for manual resolution rather than crashing the run.
   */
  async refreshSliceFromTrack(sliceId: number, trackBranch: string): Promise<boolean> {
    const branch = sliceBranch(sliceId);
    await this.git(["fetch", "origin"]);
    // Sync local to the PR head on origin first — this picks up any *external*
    // conflict resolution (e.g. a maintainer or bot fixing the PR remotely). By
    // S7 all slice work is pushed, so resetting local to origin loses nothing.
    await this.git(["checkout", "-B", branch, `origin/${branch}`]);
    try {
      await this.git(["merge", `origin/${trackBranch}`, "--no-edit"]);
    } catch {
      await this.git(["merge", "--abort"]).catch(() => {});
      return false;
    }
    await this.git(["push", "origin", branch]);
    return true;
  }

  /** Open the slice PR with base = the track branch (S5). Idempotent (§8.8). */
  async openPr(sliceId: number, base: string): Promise<PullRequest> {
    // Don't open a PR that already exists (e.g. a crash/replay between push and
    // create) — return the existing one.
    const existing = await this.getSlicePr(sliceId);
    if (existing !== null) return existing;

    const branch = sliceBranch(sliceId);
    await this.git(["push", "-u", "origin", branch]);
    const out = await this.gh([
      "pr",
      "create",
      "--repo",
      this.repo,
      "--base",
      base,
      "--head",
      branch,
      "--title",
      `Slice #${sliceId}`,
      "--body",
      `Automated slice PR for #${sliceId} (base: ${base}).`,
    ]);
    const number = parsePrNumber(out);
    return { number, base, status: "open", reviewAttempts: 0 };
  }

  /** Record a review outcome as a marker comment (S6). */
  async recordReviewVerdict(prNumber: number, verdict: Verdict): Promise<void> {
    await this.gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      this.repo,
      "--body",
      verdictComment(verdict),
    ]);
  }

  /** Re-open a changes-requested PR for re-review after a fix (S6a). */
  async reopenForReview(prNumber: number): Promise<void> {
    await this.gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      this.repo,
      "--body",
      reopenComment(),
    ]);
  }

  /** Merge the slice PR into its base — the track branch ONLY (S7). */
  async mergePr(prNumber: number): Promise<void> {
    const out = await this.gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.repo,
      "--json",
      "baseRefName",
    ]);
    const base = (JSON.parse(out) as { baseRefName: string }).baseRefName;
    if (base === this.defaultBranch) {
      throw new Error(
        `refusing to merge PR #${prNumber}: base is the default branch "${base}" (invariant #1/#6)`,
      );
    }
    await this.gh(["pr", "merge", String(prNumber), "--repo", this.repo, "--squash"]);
  }

  /**
   * Read the default branch's merge-protection state (ADR-0038 precondition).
   * Checks classic branch-protection first; on 404 falls back to the rulesets
   * effective-rules surface (`/repos/{repo}/rules/branches/{branch}`) so that
   * repos protected only via rulesets (no classic rule) are not falsely reported
   * as unprotected.  Returns unprotected defaults only when both surfaces miss.
   */
  async getMainProtection(): Promise<MainProtection> {
    // --- 1. Classic branch-protection API ---
    try {
      const out = await this.gh([
        "api",
        `repos/${this.repo}/branches/${this.defaultBranch}/protection`,
      ]);
      const data = JSON.parse(out) as {
        required_pull_request_reviews?: { required_approving_review_count?: number };
      };
      const rpr = data.required_pull_request_reviews;
      return {
        requiresPr: rpr !== undefined,
        requiresNonAuthorApproval: (rpr?.required_approving_review_count ?? 0) >= 1,
      };
    } catch {
      // Classic protection absent — fall through to rulesets surface.
    }

    // --- 2. Rulesets effective-rules API ---
    // GET /repos/{repo}/rules/branches/{branch} returns an array of rule objects
    // that are currently active for that branch, regardless of ruleset type.
    try {
      const out = await this.gh(["api", `repos/${this.repo}/rules/branches/${this.defaultBranch}`]);
      const rules = JSON.parse(out) as Array<{
        type: string;
        parameters?: { required_approving_review_count?: number };
      }>;
      const prRule = rules.find((r) => r.type === "pull_request");
      if (prRule !== undefined) {
        const reviewCount = prRule.parameters?.required_approving_review_count ?? 0;
        return {
          requiresPr: true,
          requiresNonAuthorApproval: reviewCount >= 1,
        };
      }
    } catch {
      // Rulesets surface also unavailable — fall through to unprotected default.
    }

    // Branch is unprotected (personal repo, sandbox, or API unavailable).
    return { requiresPr: false, requiresNonAuthorApproval: false };
  }

  async deleteBranch(branch: string): Promise<void> {
    // Tolerant: the branch may already be gone (e.g. merge auto-deleted it).
    await this.run("git", ["push", "origin", "--delete", branch], { cwd: this.workdir }).catch(
      (err) => console.warn(`[git-forge] deleteBranch(${branch}) failed (ignored):`, err),
    );
  }

  /**
   * Create the track branch off the default branch (T13). Idempotent: if the
   * branch already exists on origin this is a no-op (SPEC §8.8). If a prior run
   * created it locally but failed to push, reuse the local branch rather than
   * crashing on `checkout -b` (same lesson as createSliceBranch).
   */
  async createTrackBranch(branch: string): Promise<void> {
    await this.git(["fetch", "origin"]);
    const onRemote = (await this.git(["ls-remote", "--heads", "origin", branch])).trim().length > 0;
    if (onRemote) return;
    const onLocal = (await this.git(["branch", "--list", branch])).trim().length > 0;
    if (onLocal) {
      await this.git(["checkout", branch]);
    } else {
      await this.git(["checkout", "-b", branch, `origin/${this.defaultBranch}`]);
    }
    await this.git(["push", "-u", "origin", branch]);
  }

  /**
   * Look up the open track→main PR by head branch (A1 idempotent re-run).
   * Returns null when no open PR exists with that head.
   */
  async getTrackPr(headBranch: string): Promise<PullRequest | null> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--head",
      headBranch,
      "--base",
      this.defaultBranch,
      "--state",
      "open",
      "--json",
      "number,baseRefName",
    ]);
    const prs = JSON.parse(out) as { number: number; baseRefName: string }[];
    const pr = prs[0];
    if (pr === undefined) return null;
    return { number: pr.number, base: pr.baseRefName, status: "open", reviewAttempts: 0 };
  }

  /**
   * Open the track→main PR (A1). The base is always the default branch.
   * The engine never merges this PR — parking for the human is invariant #1.
   */
  async openTrackPr(params: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const out = await this.gh([
      "pr",
      "create",
      "--repo",
      this.repo,
      "--head",
      params.head,
      "--base",
      params.base,
      "--title",
      params.title,
      "--body",
      params.body,
    ]);
    const number = parsePrNumber(out);
    return { number, base: params.base, status: "open", reviewAttempts: 0 };
  }

  /**
   * Replace the body of an existing PR (A1 idempotent re-run: body may change
   * if slices were added/re-run since the PR was first opened).
   */
  async updatePrBody(prNumber: number, newBody: string): Promise<void> {
    await this.gh(["pr", "edit", String(prNumber), "--repo", this.repo, "--body", newBody]);
  }
}

// --- pure helpers (unit-tested directly) ---

/**
 * Verify ADR-0038 invariant #1 (layer 3): main must require a PR with at least
 * one non-author approval so the flow-bot principal cannot merge unilaterally.
 *
 * Returns a warning string when the protection is absent or incomplete; null
 * when the boundary is in place. Never throws.
 */
export function checkMainProtectionWarning(
  protection: MainProtection,
  actor: string,
): string | null {
  if (protection.requiresPr && protection.requiresNonAuthorApproval) return null;
  return `\u26a0 main is not protected against ${actor} \u2014 invariant #1 on layer 3 only`;
}

interface GhPr {
  number: number;
  baseRefName: string;
  comments: { body: string }[];
}

type Marker =
  | { kind: "verdict"; decision: Verdict["decision"]; findings: string[] }
  | { kind: "reopen" };

export function verdictComment(verdict: Verdict): string {
  const human = `Reviewer verdict: **${verdict.decision}**${
    verdict.findings.length > 0 ? `\n\n${verdict.findings.map((f) => `- ${f}`).join("\n")}` : ""
  }`;
  const marker: Marker = {
    kind: "verdict",
    decision: verdict.decision,
    findings: verdict.findings,
  };
  return `${human}\n\n<!-- ${MARKER} ${JSON.stringify(marker)} -->`;
}

export function reopenComment(): string {
  const marker: Marker = { kind: "reopen" };
  return `Re-opened for review after changes.\n\n<!-- ${MARKER} ${JSON.stringify(marker)} -->`;
}

/** Derive a {@link PullRequest} (status, attempts, findings) from PR comments. */
export function prFromMarkers(pr: GhPr): PullRequest {
  const markers = pr.comments
    .map((c) => parseMarker(c.body))
    .filter((m): m is Marker => m !== null);

  const last = markers.at(-1);
  let status: PullRequest["status"] = "open";
  if (last?.kind === "verdict")
    status = last.decision === "APPROVE" ? "approved" : "changes-requested";

  const verdicts = markers.filter(
    (m): m is Extract<Marker, { kind: "verdict" }> => m.kind === "verdict",
  );
  const lastVerdict = verdicts.at(-1);

  return {
    number: pr.number,
    base: pr.baseRefName,
    status,
    reviewAttempts: verdicts.length,
    ...(lastVerdict !== undefined ? { lastFindings: lastVerdict.findings } : {}),
  };
}

function parseMarker(body: string): Marker | null {
  const m = body.match(new RegExp(`<!--\\s*${MARKER}\\s*(\\{.*?\\})\\s*-->`, "s"));
  if (m === null) return null;
  try {
    return JSON.parse(m[1] ?? "") as Marker;
  } catch {
    return null;
  }
}

export function parsePrNumber(ghCreateOutput: string): number {
  const n = Number(ghCreateOutput.trim().split("/").pop());
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`could not parse PR number from: ${ghCreateOutput.trim()}`);
  return n;
}
