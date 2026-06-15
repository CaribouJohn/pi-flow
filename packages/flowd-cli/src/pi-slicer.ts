import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SlicePlan } from "@pi-flow/flow-engine";
import { Type } from "typebox";
import type { CredentialStore } from "./credentials.ts";
import type { ModelId } from "./model-config.ts";
import { type CodingSessionFactory, realSessionFactory } from "./pi-agent.ts";

/**
 * The slice agent (T12 LLM half) — a `pi-coding-agent` session that reads a
 * parent PRD and produces a structured `SlicePlan` via a `submit_slice_plan`
 * custom tool. The deterministic writer (`writeSlicePlan`, in flow-engine)
 * validates and creates the child Items + the acceptance Item.
 *
 * The slice agent is read-only: it reads the PRD (and may inspect the repo for
 * context — file list, existing ADR decisions) but never writes code. The
 * plan-review agent (#113) runs on a *different* model to independently gate.
 */

/** Built-in tools for the slicer — read-only + repo inspection (no write/bash). */
export const SLICER_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The slicer's verdict tool name — MUST be in the session allowlist too. */
export const SLICE_PLAN_TOOL = "submit_slice_plan";

export interface PiSlicerOptions {
  repo: string;
  workdir: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
}

export class PiSlicer {
  private readonly repo: string;
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;

  constructor(opts: PiSlicerOptions) {
    this.repo = opts.repo;
    this.workdir = opts.workdir;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
  }

  async slice(parentId: number, prd: string): Promise<SlicePlan> {
    const apiKey = await this.credentials.get(this.model.provider);
    if (apiKey === null) {
      throw new Error(`no API key for provider "${this.model.provider}" (slicer)`);
    }

    // The slicer reports its plan by calling this tool; we capture it.
    let captured: SlicePlan | null = null;
    const submitSlicePlan = defineTool({
      name: SLICE_PLAN_TOOL,
      label: "Submit slice plan",
      description:
        "Record your final slice plan. Call this exactly once when done. " +
        "Break the parent PRD into slices — each slice must be a self-contained, " +
        "independently-deliverable unit of work that a coding agent can implement.",
      parameters: Type.Object({
        title: Type.String({ description: "A short title for the overall track." }),
        slices: Type.Array(
          Type.Object({
            title: Type.String({ description: "Short title for this slice." }),
            brief: Type.String({
              description:
                "Self-contained implementation brief. Must include: what to change, " +
                "which files, the verification method, and the done condition.",
            }),
            effort: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
            category: Type.Union([Type.Literal("bug"), Type.Literal("enhancement")]),
            review: Type.Union([Type.Literal("agent"), Type.Literal("human")], {
              description: "agent (default) or human when the slice needs human judgment.",
            }),
            dependsOn: Type.Optional(
              Type.Array(Type.Integer(), {
                description:
                  "Indices into the slices array (0-based) that this slice depends on. " +
                  "Omit for the first slice with no dependencies.",
              }),
            ),
          }),
          { description: "Ordered list of slices. First slice must have no dependsOn." },
        ),
      }),
      execute: async (_toolCallId, params) => {
        captured = {
          title: params.title,
          slices: params.slices.map((s) => ({
            title: s.title,
            brief: s.brief,
            effort: s.effort,
            category: s.category,
            review: s.review,
            dependsOn: s.dependsOn,
          })),
        };
        return { content: [{ type: "text", text: "slice plan recorded" }], details: {} };
      },
    });

    const session = await this.sessionFactory({
      model: this.model,
      apiKey,
      cwd: this.workdir,
      tools: [...SLICER_TOOLS, SLICE_PLAN_TOOL],
      customTools: [submitSlicePlan],
    });
    await session.prompt(buildSlicePrompt(parentId, prd));

    // Prose-only nudge: the plan only counts via the tool.
    if (captured === null) {
      await session.prompt(SLICE_PLAN_NUDGE);
    }

    if (captured === null) {
      throw new Error("Slice agent did not submit a slice plan");
    }

    return captured;
  }
}

/** Sent if the model answered without calling the verdict tool. */
export const SLICE_PLAN_NUDGE =
  "You have not submitted a slice plan. Do NOT answer in prose. The ONLY way to finish " +
  "this slicing session is to call the `submit_slice_plan` tool now with `title` and `slices`.";

export function buildSlicePrompt(parentId: number, prd: string): string {
  return [
    "You are a decomposition agent. Your job is to read a parent PRD and break it into",
    "self-contained, independently-deliverable slices that coding agents can implement.",
    "",
    "## Rules for slicing",
    "",
    "1. **Tracer-bullet vertical slices** — each slice delivers a user-visible or testable",
    '   increment. No horizontal layers ("the database layer", "the UI layer").',
    "2. **Self-contained brief** — every slice's brief must include: what to change,",
    "   which files are involved, the verification method, and the done condition.",
    "3. **effort:high is an escalation trigger** — only use `high` when the slice genuinely",
    "   needs a stronger model. Prefer `medium` for most work; `low` for trivial changes.",
    "4. **review:agent by default** — use `human` only when the slice touches auth, secrets,",
    "   irreversible data migrations, or needs human judgment.",
    "5. **Dependencies are indices** — `dependsOn` carries zero-based indices into the",
    "   `slices` array, NOT issue numbers. The first slice must have no `dependsOn`.",
    "6. **No cycles** — the dependency graph must be a DAG.",
    "",
    "Read the PRD below. Use your tools to explore the repository for context (ADR files,",
    "existing code structure, package layout) so your slices reference real file paths.",
    "Then call `submit_slice_plan` exactly once.",
    "",
    "CRITICAL: your plan is ONLY complete when you call the `submit_slice_plan` tool.",
    "Do NOT write your plan as prose or a summary — it will be ignored.",
    "",
    `## Parent PRD (#${parentId})`,
    prd,
  ].join("\n");
}
