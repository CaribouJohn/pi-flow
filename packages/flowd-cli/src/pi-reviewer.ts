import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentContext, Verdict } from "@pi-flow/flow-engine";
import { Type } from "typebox";
import type { CredentialStore } from "./credentials.ts";
import { sliceBranch } from "./git-forge.ts";
import type { ModelId } from "./model-config.ts";
import { type CodingSessionFactory, realCheckout, realGh, realSessionFactory } from "./pi-agent.ts";

/**
 * The reviewer half of the engine's `AgentPort` (#87): a read-only
 * `pi-coding-agent` session on a *different model* than the implementer that
 * investigates the slice's diff and returns a structured verdict via a
 * `submit_verdict` custom tool. Read-only built-in tools (no write/bash) keep
 * the reviewer from mutating the code it judges.
 */

/** Read-only built-in tools for the reviewer (no write/edit/bash — can't mutate). */
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface PiReviewerOptions {
  repo: string;
  workdir: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
  gh?: (args: string[]) => Promise<string>;
  checkout?: (workdir: string, branch: string) => Promise<void>;
}

export class PiReviewer {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;
  private readonly gh: (args: string[]) => Promise<string>;
  private readonly checkout: (workdir: string, branch: string) => Promise<void>;

  constructor(opts: PiReviewerOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
    this.gh = opts.gh ?? realGh;
    this.checkout = opts.checkout ?? realCheckout;
  }

  async review(ctx: AgentContext): Promise<Verdict> {
    const apiKey = await this.credentials.get(this.model.provider);
    if (apiKey === null) {
      throw new Error(`no API key for provider "${this.model.provider}" (reviewer)`);
    }
    await this.checkout(this.workdir, ctx.branch);
    const diff = await this.fetchDiff(ctx.sliceId);
    if (diff.length === 0) {
      throw new Error(`no diff to review for slice #${ctx.sliceId} (empty PR diff)`);
    }

    // The reviewer reports its decision by calling this tool; we capture it.
    let captured: Verdict | null = null;
    const submitVerdict = defineTool({
      name: "submit_verdict",
      label: "Submit review verdict",
      description: "Record your final review decision. Call this exactly once when done.",
      parameters: Type.Object({
        decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES")]),
        findings: Type.Array(Type.String(), {
          description: "Specific issues found (empty if approving).",
        }),
      }),
      execute: async (_toolCallId, params) => {
        captured = { decision: params.decision, findings: params.findings };
        return { content: [{ type: "text", text: "verdict recorded" }], details: {} };
      },
    });

    const session = await this.sessionFactory({
      model: this.model,
      apiKey,
      cwd: this.workdir,
      tools: [...REVIEWER_TOOLS],
      customTools: [submitVerdict],
    });
    await session.prompt(buildReviewPrompt(diff));

    // Fail safe: a reviewer that never submitted a verdict is treated as a
    // rejection, never a silent approve (never merge past an unclear gate).
    return (
      captured ?? { decision: "REQUEST_CHANGES", findings: ["reviewer did not submit a verdict"] }
    );
  }

  private async fetchDiff(sliceId: number): Promise<string> {
    return (await this.gh(["pr", "diff", sliceBranch(sliceId), "--repo", this.repo])).trim();
  }
}

export function buildReviewPrompt(diff: string): string {
  return [
    "You are an INDEPENDENT, ADVERSARIAL code reviewer. You did NOT write this code.",
    "Investigate the change below — read the surrounding code with your tools, don't",
    "just skim the diff. Decide APPROVE or REQUEST_CHANGES; default to REQUEST_CHANGES",
    "if anything is materially wrong. When done, call `submit_verdict` exactly once.",
    "",
    "## Diff under review",
    diff,
  ].join("\n");
}
