import { describe, expect, test } from "bun:test";
import { type SlicePlan, ZERO_SLICE_COST } from "@pi-flow/flow-engine";
import { PiSlicer, SLICER_TOOLS, SLICE_PLAN_TOOL, buildSlicePrompt } from "../src/pi-slicer.ts";
import { makeCredentials } from "./helpers.ts";

const MODEL = { provider: "openai", id: "gpt-5" };

// ── Prompt building ─────────────────────────────────────────────────────────

describe("buildSlicePrompt", () => {
  test("includes the PRD body", () => {
    const p = buildSlicePrompt("THE PRD CONTENT");
    expect(p).toContain("THE PRD CONTENT");
  });

  test("instructs to call submit_slice_plan", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("submit_slice_plan");
  });

  test("includes the agent-ready bar guidance", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("agent-ready");
    expect(p).toContain("verification method");
    expect(p).toContain("blast radius");
  });

  test("includes vertical-slice and dependency-ordering guidance", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("vertical");
    expect(p).toContain("dependency-ordered");
  });

  test("includes review:human guidance", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("review:human");
    expect(p).toContain("judgment");
  });

  test("includes effort classification guidance", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("effort:low");
    expect(p).toContain("effort:medium");
    expect(p).toContain("effort:high");
  });

  test("instructs to investigate CONTEXT.md and ADRs", () => {
    const p = buildSlicePrompt("PRD");
    expect(p).toContain("CONTEXT.md");
    expect(p).toContain("adr");
  });
});

// ── Agent behaviour (fake session) ──────────────────────────────────────────

/** A minimal valid plan — two vertical, independent slices. */
const twoSlicePlan: SlicePlan = {
  title: "Example plan",
  slices: [
    {
      title: "Add foo module",
      brief: "Add src/foo.ts with the Foo class. test-verifiable.",
      effort: "low",
      category: "enhancement",
      review: "agent",
    },
    {
      title: "Wire foo into bar",
      brief: "Import Foo in src/bar.ts and call it. test-verifiable.",
      effort: "medium",
      category: "enhancement",
      review: "agent",
      dependsOn: [0],
    },
  ],
};

/** A plan with a review:human slice. */
const humanSlicePlan: SlicePlan = {
  title: "Plan with human slice",
  slices: [
    {
      title: "Manual config update",
      brief: "Update production config — needs external access. verify-gate-only.",
      effort: "low",
      category: "enhancement",
      review: "human",
    },
  ],
};

describe("PiSlicer.slice", () => {
  function slicer(opts: { submit?: SlicePlan; key?: boolean; submitOnCall?: number }) {
    let toolsSeen: readonly string[] | undefined;
    let promptCalls = 0;
    const pi = new PiSlicer({
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials(opts.key === false ? {} : { openai: "sk" }),
      sessionFactory: async (sopts) => {
        toolsSeen = sopts.tools as readonly string[] | undefined;
        return {
          prompt: async () => {
            promptCalls++;
            // Simulate the slicer calling the real submit_slice_plan tool on the
            // configured prompt (1st call by default; 2nd = after the nudge).
            const tool = sopts.customTools?.[0];
            if (
              opts.submit !== undefined &&
              tool !== undefined &&
              promptCalls === (opts.submitOnCall ?? 1)
            ) {
              const exec = tool.execute as unknown as (
                id: string,
                p: SlicePlan,
              ) => Promise<unknown>;
              await exec("call-1", opts.submit);
            }
            return ZERO_SLICE_COST;
          },
        };
      },
    });
    return { pi, tools: () => toolsSeen };
  }

  test("returns the plan the slicer submits", async () => {
    const { pi } = slicer({ submit: twoSlicePlan });
    const plan = await pi.slice("PRD body");
    expect(plan.title).toBe("Example plan");
    expect(plan.slices).toHaveLength(2);
    expect(plan.slices[0]?.title).toBe("Add foo module");
    expect(plan.slices[1]?.dependsOn).toEqual([0]);
  });

  test("returns a plan with review:human", async () => {
    const { pi } = slicer({ submit: humanSlicePlan });
    const plan = await pi.slice("PRD body");
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.review).toBe("human");
  });

  test("preserves all slice fields (effort, category, brief)", async () => {
    const plan: SlicePlan = {
      title: "Full field test",
      slices: [
        {
          title: "Bug fix",
          brief: "Fix the thing. test-verifiable.",
          effort: "high",
          category: "bug",
          review: "agent",
        },
      ],
    };
    const { pi } = slicer({ submit: plan });
    const result = await pi.slice("PRD");
    expect(result.slices[0]?.effort).toBe("high");
    expect(result.slices[0]?.category).toBe("bug");
    expect(result.slices[0]?.brief).toBe("Fix the thing. test-verifiable.");
  });

  test("nudges and captures a plan submitted only after the nudge", async () => {
    const { pi } = slicer({ submit: twoSlicePlan, submitOnCall: 2 });
    const plan = await pi.slice("PRD");
    expect(plan.slices).toHaveLength(2);
  });

  test("throws when no plan is submitted even after the nudge", async () => {
    const { pi } = slicer({});
    await expect(pi.slice("PRD")).rejects.toThrow(/did not submit.*slice plan/);
  });

  test("allowlists read-only tools + submit_slice_plan (no bash/write)", async () => {
    const { pi, tools } = slicer({ submit: twoSlicePlan });
    await pi.slice("PRD");
    // submit_slice_plan MUST be allowlisted or the slicer can't report a plan
    // (the bug that would cause "slicer did not submit a slice plan").
    expect(tools()).toEqual([...SLICER_TOOLS, SLICE_PLAN_TOOL]);
    expect(tools()).not.toContain("bash");
    expect(tools()).not.toContain("write");
    expect(tools()).not.toContain("edit");
  });

  test("throws without an API key", async () => {
    const { pi } = slicer({ key: false });
    await expect(pi.slice("PRD")).rejects.toThrow(/no API key/);
  });
});
