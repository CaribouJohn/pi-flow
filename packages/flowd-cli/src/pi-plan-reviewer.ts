import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PlanReviewVerdict } from "@pi-flow/flow-engine";
import { Type } from "typebox";
import type { CredentialStore } from "./credentials.ts";
import { parseParent } from "./github-tracker.ts";
import type { ModelId } from "./model-config.ts";
import { type CodingSessionFactory, realGh, realSessionFactory } from "./pi-agent.ts";

/**
 * The plan-review agent (T13/T14 LLM half): a read-only `pi-coding-agent`
 * session on a **different model** than the slicer. It reads the parent PRD
 * and every child item, then emits a structured `submit_plan_review` verdict.
 *
 * The plan-review agent judges three semantic smells:
 *   1. ADR conflict — a slice contradicts an existing architectural decision.
 *   2. Irreversible migration — schema migration that drops data/columns with
 *      no rollback path.
 *   3. Security surface — a slice touches auth, secrets, or network exposure.
 *
 * The deterministic `effort:high` smell is the engine's job (slice 4, SPEC §4.4),
 * NOT this agent's.
 */

/** Read-only built-in tools for the plan-reviewer (no write/edit/bash — can't mutate). */
export const PLAN_REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The plan-reviewer's verdict tool name — MUST be in the session allowlist too. */
export const PLAN_VERDICT_TOOL = "submit_plan_review";

interface ChildBrief {
  id: number;
  body: string;
}

export interface PiPlanReviewerOptions {
  repo: string;
  workdir: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
  gh?: (args: string[]) => Promise<string>;
}

export class PiPlanReviewer {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;
  private readonly gh: (args: string[]) => Promise<string>;

  constructor(opts: PiPlanReviewerOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
    this.gh = opts.gh ?? realGh;
  }

  async review(parentId: number): Promise<PlanReviewVerdict> {
    const apiKey = await this.credentials.get(this.model.provider);
    if (apiKey === null) {
      throw new Error(`no API key for provider "${this.model.provider}" (plan-reviewer)`);
    }

    // Fetch the parent PRD body and all child item bodies.
    const prd = await this.fetchBody(parentId);
    const children = await this.listChildren(parentId);
    const bodies = await Promise.all(
      children.map(async (n) => ({ id: n, body: await this.fetchBody(n) })),
    );

    // The plan-reviewer reports its decision by calling this tool; we capture it.
    let captured: PlanReviewVerdict | null = null;
    const submitPlanReview = defineTool({
      name: PLAN_VERDICT_TOOL,
      label: "Submit plan review verdict",
      description:
        "Record your final plan-review decision. Call this exactly once when done. " +
        "Judge the plan for ADR conflicts, irreversible migrations, and security surface. " +
        "For each child item, determine whether it is ready for an agent to implement.",
      parameters: Type.Object({
        decision: Type.Union([Type.Literal("CLEAR"), Type.Literal("ESCALATE")]),
        risks: Type.Array(Type.String(), {
          description:
            "Named risks found. Empty if CLEAR with no concerns. MUST be non-empty for ESCALATE.",
        }),
        childAgentReady: Type.Record(
          Type.String(),
          Type.Object({
            pass: Type.Boolean({
              description: "True when this child item is clear for an agent to implement.",
            }),
            reason: Type.Optional(
              Type.String({ description: "Why the check failed (only when pass=false)." }),
            ),
          }),
          {
            description: "Per-child agent-ready results, keyed by child issue number (as string).",
          },
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Convert the record keys from strings to numbers for the domain model.
        const childAgentReady: Record<number, { pass: boolean; reason?: string }> = {};
        for (const [k, v] of Object.entries(params.childAgentReady)) {
          childAgentReady[Number(k)] = {
            pass: v.pass,
            ...(v.reason !== undefined ? { reason: v.reason } : {}),
          };
        }
        captured = {
          decision: params.decision,
          risks: params.risks,
          childAgentReady,
        };
        return { content: [{ type: "text", text: "plan review verdict recorded" }], details: {} };
      },
    });

    const session = await this.sessionFactory({
      model: this.model,
      apiKey,
      cwd: this.workdir,
      // The allowlist gates custom tools too — submit_plan_review MUST be listed
      // or the plan-reviewer can't report (and the fail-safe escalates).
      tools: [...PLAN_REVIEW_TOOLS, PLAN_VERDICT_TOOL],
      customTools: [submitPlanReview],
    });
    await session.prompt(buildPlanReviewPrompt(parentId, prd, bodies));

    // Prose-only nudge: the verdict only counts via the tool.
    if (captured === null) {
      await session.prompt(PLAN_VERDICT_NUDGE);
    }

    // Fail safe: a plan-reviewer that never submitted a verdict escalates —
    // never a silent clear past an unchecked gate.
    return (
      captured ?? {
        decision: "ESCALATE",
        risks: ["Plan review agent did not submit a verdict"],
        childAgentReady: {},
      }
    );
  }

  private async fetchBody(itemId: number): Promise<string> {
    return (
      await this.gh([
        "issue",
        "view",
        String(itemId),
        "--repo",
        this.repo,
        "--json",
        "body",
        "-q",
        ".body",
      ])
    ).trim();
  }

  private async listChildren(parentId: number): Promise<number[]> {
    // Use `gh api --paginate` to fetch ALL issues without a per-call cap.
    // `gh issue list --limit` tops out at 1000 and silently drops the rest.
    // The REST /issues endpoint also returns pull-requests — filter those out
    // by dropping any item that carries a `pull_request` key.
    // Children are matched by the `Parent: #<n>` marker in their body.
    const out = await this.gh(["api", "--paginate", `repos/${this.repo}/issues?state=all`]);
    const all = JSON.parse(out) as {
      number: number;
      body: string | null;
      pull_request?: unknown;
    }[];
    return all
      .filter((i) => i.pull_request === undefined)
      .filter((i) => parseParent(i.body ?? "") === parentId)
      .map((i) => i.number);
  }
}

/** Sent if the model answered without calling the verdict tool. */
export const PLAN_VERDICT_NUDGE =
  "You have not recorded a plan-review verdict. Do NOT answer in prose. The ONLY way to finish " +
  "this review is to call the `submit_plan_review` tool now, with `decision` (CLEAR or ESCALATE), " +
  "`risks`, and `childAgentReady`.";

export function buildPlanReviewPrompt(
  parentId: number,
  prd: string,
  children: ChildBrief[],
): string {
  const childSections = children
    .map((c) => `### Child #${c.id}\n\n${c.body || "(empty body)"}`)
    .join("\n\n---\n\n");

  return [
    "You are an INDEPENDENT plan reviewer. You did NOT write this plan. Your job is to judge",
    "whether the plan below is sound enough for autonomous agents to implement.",
    "",
    "Read the parent PRD and every child item below. Use your tools to investigate the",
    "repository for context (ADR files, security patterns, migration scripts, auth modules).",
    "Then call `submit_plan_review` exactly once.",
    "",
    "## What to judge (three semantic smells)",
    "",
    "1. **ADR conflict** — does any slice contradict an existing architectural decision",
    "   record (files in docs/adr/ or similar)? If so, name the ADR and the conflicting slice.",
    "2. **Irreversible migration** — does any slice define a data/schema migration that drops",
    "   columns, tables, or data with no rollback path? Name the migration.",
    "3. **Security surface** — does any slice touch authentication, authorization, secrets",
    "   management, or network exposure in a way the PRD does not account for?",
    "",
    "For each child item, set `pass: true` in `childAgentReady` only when you believe an",
    "autonomous coding agent can implement it safely. Set `pass: false` with a `reason`",
    "when the item is too ambiguous, missing a verification method, or depends on a decision",
    "that is not yet made.",
    "",
    "Set `decision: CLEAR` when no named risks exist AND every child passes agent-ready.",
    "Set `decision: ESCALATE` when any risk is present OR any child fails agent-ready.",
    "A CLEAR decision MUST have an empty `risks` array — do NOT include non-escalating notes.",
    "",
    "CRITICAL: your review is ONLY complete when you call the `submit_plan_review` tool.",
    "Do NOT write your decision as prose or a summary — it will be ignored. Call",
    "`submit_plan_review` exactly once.",
    "",
    `## Parent PRD (#${parentId})`,
    prd,
    "",
    `## Child items (${children.length} total)`,
    childSections || "(no child items found — escalate)",
  ].join("\n");
}
