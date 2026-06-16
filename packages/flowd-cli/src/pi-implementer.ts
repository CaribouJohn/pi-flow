import {
  type AgentContext,
  type SliceCost,
  ZERO_SLICE_COST,
  addSliceCosts,
} from "@pi-flow/flow-engine";
import type { CredentialStore } from "./credentials.ts";
import type { ModelId } from "./model-config.ts";
import {
  type CodingSessionFactory,
  realCheckout,
  realCommit,
  realGh,
  realHasCommitsAhead,
  realSessionFactory,
} from "./pi-agent.ts";

/**
 * The implementer half of the engine's `AgentPort` (#86): a `pi-coding-agent`
 * session that writes a slice's code in the workdir, then commits it on the
 * slice branch. The brief comes from the slice issue body; the API key from the
 * credential store (never the ambient env).
 */
export interface PiImplementerOptions {
  repo: string;
  workdir: string;
  /** The track branch the slice merges into — used to detect existing work. */
  trackBranch: string;
  /** The exact verify-gate command (config.verifyCommand) the agent must run green. */
  verifyCommand: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
  gh?: (args: string[]) => Promise<string>;
  commit?: (workdir: string, message: string) => Promise<boolean>;
  checkout?: (workdir: string, branch: string) => Promise<void>;
  hasCommitsAhead?: (workdir: string, base: string) => Promise<boolean>;
}

export class PiImplementer {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;
  private readonly gh: (args: string[]) => Promise<string>;
  private readonly commit: (workdir: string, message: string) => Promise<boolean>;
  private readonly checkout: (workdir: string, branch: string) => Promise<void>;
  private readonly trackBranch: string;
  private readonly verifyCommand: string;
  private readonly hasCommitsAhead: (workdir: string, base: string) => Promise<boolean>;

  constructor(opts: PiImplementerOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.trackBranch = opts.trackBranch;
    this.verifyCommand = opts.verifyCommand;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
    this.gh = opts.gh ?? realGh;
    this.commit = opts.commit ?? realCommit;
    this.checkout = opts.checkout ?? realCheckout;
    this.hasCommitsAhead = opts.hasCommitsAhead ?? realHasCommitsAhead;
  }

  async implement(ctx: AgentContext): Promise<SliceCost> {
    const apiKey = await this.credentials.get(this.model.provider);
    if (apiKey === null) {
      throw new Error(`no API key for provider "${this.model.provider}" (implementer)`);
    }
    // Work and commit on the slice branch explicitly — never trust the workdir's
    // current branch (a wrong-branch commit would corrupt the track).
    await this.checkout(this.workdir, ctx.branch);
    const brief = await this.fetchBrief(ctx.sliceId);
    if (brief.length === 0) {
      throw new Error(`slice #${ctx.sliceId} has no brief (empty issue body)`);
    }
    const session = await this.sessionFactory({ model: this.model, apiKey, cwd: this.workdir });
    // Accumulate usage across all prompt() calls in this session.
    let sessionCost = ZERO_SLICE_COST;
    sessionCost = addSliceCosts(
      sessionCost,
      await session.prompt(buildImplementPrompt(brief, this.verifyCommand, ctx.priorFindings)),
    );

    const committed = await this.commit(this.workdir, `flow-bot: implement slice #${ctx.sliceId}`);
    // Success = the slice branch carries an implementation. That's true if this
    // run committed changes OR the branch already has commits ahead of the track
    // branch (a prior run implemented it — idempotent re-entry, SPEC §8.8). Only
    // a genuinely empty slice (no new changes, nothing ahead) is a failure.
    const hasWork = committed || (await this.hasCommitsAhead(this.workdir, this.trackBranch));
    if (!hasWork) {
      throw new Error(`implementer produced no changes for slice #${ctx.sliceId}`);
    }
    return sessionCost;
  }

  private async fetchBrief(sliceId: number): Promise<string> {
    const out = await this.gh([
      "issue",
      "view",
      String(sliceId),
      "--repo",
      this.repo,
      "--json",
      "body",
      "-q",
      ".body",
    ]);
    return out.trim();
  }
}

export function buildImplementPrompt(
  brief: string,
  verifyCommand: string,
  priorFindings?: string[],
): string {
  const base = [
    "You are implementing a single, self-contained slice of work in this repository.",
    "Read the brief and make the change.",
    "",
    "## Verify gate (mandatory before you finish)",
    "Before you consider the work done, you MUST run the project's verify gate — this exact",
    "command, in full, not a self-chosen subset of it:",
    "",
    `    ${verifyCommand}`,
    "",
    "Run that command and confirm it exits cleanly (every step — lint, typecheck, and tests —",
    "green). If it fails, fix the cause and run it again until it passes. The gate spans the",
    "WHOLE repository: a change to a shared interface or type can break a different package",
    "than the one you edited, so running only one package's tests is not enough.",
    "",
    "## Brief",
    brief,
  ].join("\n");
  if (priorFindings !== undefined && priorFindings.length > 0) {
    return [
      base,
      "",
      "## A previous review requested changes — address each of these:",
      ...priorFindings.map((f) => `- ${f}`),
    ].join("\n");
  }
  return base;
}
