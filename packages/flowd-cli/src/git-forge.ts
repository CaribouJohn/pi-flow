import type { ForgePort, PullRequest, Verdict } from "@pi-flow/flow-engine";
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
    await this.git(["checkout", trackBranch]);
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
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--head",
      sliceBranch(sliceId),
      "--state",
      "all",
      "--json",
      "number,baseRefName,comments",
    ]);
    const prs = JSON.parse(out) as GhPr[];
    const pr = prs[0];
    if (pr === undefined) return null;
    return prFromMarkers(pr);
  }

  /** Create the slice branch off the track branch (S2). Not pushed until openPr. */
  async createSliceBranch(sliceId: number, fromBranch: string): Promise<string> {
    const branch = sliceBranch(sliceId);
    await this.git(["fetch", "origin"]);
    await this.git(["checkout", fromBranch]);
    await this.git(["checkout", "-B", branch]);
    return branch;
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

  async deleteBranch(branch: string): Promise<void> {
    // Tolerant: the branch may already be gone (e.g. merge auto-deleted it).
    await this.run("git", ["push", "origin", "--delete", branch], { cwd: this.workdir }).catch(
      (err) => console.warn(`[git-forge] deleteBranch(${branch}) failed (ignored):`, err),
    );
  }
}

// --- pure helpers (unit-tested directly) ---

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

function parsePrNumber(ghCreateOutput: string): number {
  const n = Number(ghCreateOutput.trim().split("/").pop());
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`could not parse PR number from: ${ghCreateOutput.trim()}`);
  return n;
}
