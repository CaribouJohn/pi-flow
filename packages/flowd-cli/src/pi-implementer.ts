import type { AgentContext } from "@pi-flow/flow-engine";
import type { CredentialStore } from "./credentials.ts";
import type { ModelId } from "./model-config.ts";
import { type CodingSessionFactory, realCommit, realGh, realSessionFactory } from "./pi-agent.ts";

/**
 * The implementer half of the engine's `AgentPort` (#86): a `pi-coding-agent`
 * session that writes a slice's code in the workdir, then commits it on the
 * slice branch. The brief comes from the slice issue body; the API key from the
 * credential store (never the ambient env).
 */
export interface PiImplementerOptions {
  repo: string;
  workdir: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
  gh?: (args: string[]) => Promise<string>;
  commit?: (workdir: string, message: string) => Promise<boolean>;
}

export class PiImplementer {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;
  private readonly gh: (args: string[]) => Promise<string>;
  private readonly commit: (workdir: string, message: string) => Promise<boolean>;

  constructor(opts: PiImplementerOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
    this.gh = opts.gh ?? realGh;
    this.commit = opts.commit ?? realCommit;
  }

  async implement(ctx: AgentContext): Promise<void> {
    const apiKey = await this.credentials.get(this.model.provider);
    if (apiKey === null) {
      throw new Error(`no API key for provider "${this.model.provider}" (implementer)`);
    }
    const brief = await this.fetchBrief(ctx.sliceId);
    const session = await this.sessionFactory({ model: this.model, apiKey, cwd: this.workdir });
    await session.prompt(buildImplementPrompt(brief, ctx.priorFindings));

    const committed = await this.commit(this.workdir, `flow-bot: implement slice #${ctx.sliceId}`);
    if (!committed) {
      throw new Error(`implementer produced no changes for slice #${ctx.sliceId}`);
    }
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

export function buildImplementPrompt(brief: string, priorFindings?: string[]): string {
  const base = [
    "You are implementing a single, self-contained slice of work in this repository.",
    "Read the brief, make the change, and ensure the project's verify gate passes.",
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
