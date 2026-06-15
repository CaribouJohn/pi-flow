import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SlicePlan } from "@pi-flow/flow-engine";
import { Type } from "typebox";
import type { CredentialStore } from "./credentials.ts";
import type { ModelId } from "./model-config.ts";
import { type CodingSessionFactory, realSessionFactory } from "./pi-agent.ts";

/**
 * The slice agent (T12, the LLM half): a read-only `pi-coding-agent` session
 * that reads the PRD + repo docs (CONTEXT.md, ADRs, the agent-ready bar) and
 * emits a decomposition via a `submit_slice_plan` custom tool.
 *
 * The agent **never writes to the tracker** — it only emits the plan; the
 * orchestrator (slice-plan.ts) does the writes (SPEC §8.4).
 */

/** Read-only built-in tools for the slicer (no write/edit/bash — can't mutate). */
export const SLICER_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The slicer's plan tool name — MUST be in the session allowlist too. */
export const SLICE_PLAN_TOOL = "submit_slice_plan";

export interface PiSlicerOptions {
  workdir: string;
  model: ModelId;
  credentials: CredentialStore;
  sessionFactory?: CodingSessionFactory;
}

export class PiSlicer {
  private readonly workdir: string;
  private readonly model: ModelId;
  private readonly credentials: CredentialStore;
  private readonly sessionFactory: CodingSessionFactory;

  constructor(opts: PiSlicerOptions) {
    this.workdir = opts.workdir;
    this.model = opts.model;
    this.credentials = opts.credentials;
    this.sessionFactory = opts.sessionFactory ?? realSessionFactory;
  }

  async slice(prdBody: string): Promise<SlicePlan> {
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
        "Submit the slice decomposition plan. Call this exactly once when done. " +
        "The plan must contain a title and a non-empty list of vertical slices, each " +
        "with title, brief, effort, category, review policy, and optional dependsOn indices.",
      parameters: Type.Object({
        title: Type.String({ description: "Descriptive title for the overall track/plan" }),
        slices: Type.Array(
          Type.Object({
            title: Type.String({ description: "Short, descriptive slice title" }),
            brief: Type.String({
              description:
                "What to build and why — the agent's implementation brief. " +
                "Must name files/regions when known and include a verification method.",
            }),
            effort: Type.Union(
              [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
              {
                description:
                  "Reasoning effort: low (mechanical), medium (needs care), high (heavy)",
              },
            ),
            category: Type.Union([Type.Literal("bug"), Type.Literal("enhancement")], {
              description: "Issue category",
            }),
            review: Type.Union([Type.Literal("agent"), Type.Literal("human")], {
              description:
                "review:agent by default. Use review:human only for slices needing judgment calls, " +
                "external access, or manual/native work that an agent cannot self-verify.",
            }),
            dependsOn: Type.Optional(
              Type.Array(Type.Number(), {
                description:
                  "Zero-based indices into the slices array for dependencies. " +
                  "Omit or leave empty if this slice has no dependencies.",
              }),
            ),
          }),
          { description: "The list of vertical slices, dependency-ordered", minItems: 1 },
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
            ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
          })),
        };
        return { content: [{ type: "text", text: "slice plan recorded" }], details: {} };
      },
    });

    const session = await this.sessionFactory({
      model: this.model,
      apiKey,
      cwd: this.workdir,
      // The allowlist gates custom tools too — submit_slice_plan MUST be listed
      // or the slicer can't report a plan (and the fail-safe would reject).
      tools: [...SLICER_TOOLS, SLICE_PLAN_TOOL],
      customTools: [submitSlicePlan],
    });
    await session.prompt(buildSlicePrompt(prdBody));

    // Some models state the plan in prose instead of calling the tool. Nudge
    // once: the plan only counts if it comes through submit_slice_plan.
    if (captured === null) {
      await session.prompt(SLICE_NUDGE);
    }

    // Fail safe: a slicer that never submitted a plan fails loudly — never a
    // silent empty plan (the orchestrator cannot proceed without a valid plan).
    if (captured === null) {
      throw new Error("slicer did not submit a slice plan — no plan to decompose");
    }

    return captured;
  }
}

/** Sent if the model answered without calling the plan tool. */
export const SLICE_NUDGE =
  "You have not submitted a slice plan. Do NOT answer in prose. The ONLY way to finish " +
  "this task is to call the `submit_slice_plan` tool now, with `title` and `slices` " +
  "(each with `title`, `brief`, `effort`, `category`, `review`, and optional `dependsOn`).";

export function buildSlicePrompt(prdBody: string): string {
  return [
    "You are a planning agent. Your job is to read a PRD and decompose it into",
    "vertical, dependency-ordered slices — the units an autonomous coding agent",
    "will implement one at a time.",
    "",
    "You have read-only tools (read/grep/find/ls). Use them to investigate the",
    "repository for context: the CONTEXT.md, ADR files in docs/adr/, the agent-ready",
    "bar in docs/agents/agent-ready-issues.md, and any relevant source code. The",
    "more you understand the existing codebase, the more accurate your slices will be.",
    "",
    "## The agent-ready bar (your output must meet this contract)",
    "",
    "Every slice you produce is a contract an agent must fulfill. Each slice's `brief`",
    "must meet these criteria (from docs/agents/agent-ready-issues.md):",
    "",
    "1. **No open design calls** — decisions are already made, in the brief.",
    "2. **Names a verification method** — `test-verifiable` (preferred) or",
    "   `verify-gate-only` (for pure refactors). Never 'looks right'.",
    "3. **Small blast radius** — one concern, few files, reviews at a glance.",
    "4. **Names files/regions when known** — exact paths keep the blast radius small",
    "   and let the plan-reviewer validate scope.",
    "",
    "## How to decompose",
    "",
    "- **Vertical slices by default** — each slice is independently valuable and",
    "  produces a working increment of the feature.",
    "- **Dependency-ordered** — slices earlier in the list must not depend on later",
    "  ones. Use `dependsOn` (zero-based indices) to express explicit dependencies.",
    "- **Effort classification**:",
    "  - `effort:low` — mechanical; rename, add a guard, copy an existing pattern.",
    "  - `effort:medium` — specified but needs care; new component following existing",
    "    ones, multi-file wiring.",
    "  - `effort:high` — reasoning-heavy even when fully specified. Prefer decomposing",
    "    further rather than leaving a slice with `effort:high`.",
    "- **`review:human`** — mark a slice `review:human` (instead of the default",
    "  `review:agent`) ONLY when it genuinely needs a human to implement: judgment",
    "  calls an agent cannot make, external access only a human has, or manual/native",
    "  work that cannot be self-verified. For everything else, use `review:agent`.",
    "- **`ready-for-human` vs `ready-for-agent`** — a `review:human` slice becomes",
    "  `ready-for-human` in the tracker (a human must implement it). A `review:agent`",
    "  slice with a complete brief becomes `ready-for-agent`. If a slice is too",
    "  ambiguous for an agent even with `review:agent`, it belongs in a further",
    "  decomposition round — do NOT emit it.",
    "",
    "## Rules",
    "",
    "- The `slices` array must be non-empty.",
    "- Every `dependsOn` index must reference a valid slice index (0..slices.length-1).",
    "  No dangling references.",
    "- No dependency cycles — the graph must be acyclic.",
    "- Each slice's `brief` is its implementation contract — be concrete, name files",
    "  and symbols when you can, and always include the verification method.",
    "- Decompose until leaves are `effort:low` or `effort:medium`. If a leaf genuinely",
    "  cannot be reduced below `effort:high`, leave it as-is (but prefer splitting it).",
    "",
    "CRITICAL: your task is ONLY complete when you call the `submit_slice_plan` tool.",
    "Do NOT write your plan as prose or a summary — it will be ignored. Call",
    "`submit_slice_plan` exactly once with `title` and `slices`.",
    "",
    "## PRD to slice",
    prdBody,
  ].join("\n");
}
