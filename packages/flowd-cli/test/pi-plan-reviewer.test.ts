import { describe, expect, test } from "bun:test";
import { type PlanReviewVerdict, ZERO_SLICE_COST } from "@pi-flow/flow-engine";
import {
  PLAN_REVIEW_TOOLS,
  PLAN_VERDICT_TOOL,
  PiPlanReviewer,
  buildPlanReviewPrompt,
} from "../src/pi-plan-reviewer.ts";
import { makeCredentials } from "./helpers.ts";

const MODEL = { provider: "openai", id: "gpt-5" };

// ── Prompt building ─────────────────────────────────────────────────────────

describe("buildPlanReviewPrompt", () => {
  test("includes the PRD body and child items", () => {
    const p = buildPlanReviewPrompt(1, "THE PRD", [
      { id: 10, body: "child 10 body" },
      { id: 11, body: "child 11 body" },
    ]);
    expect(p).toContain("THE PRD");
    expect(p).toContain("child 10 body");
    expect(p).toContain("child 11 body");
  });

  test("includes the three semantic smells in the instructions", () => {
    const p = buildPlanReviewPrompt(1, "PRD", [{ id: 10, body: "body" }]);
    expect(p).toContain("ADR conflict");
    expect(p).toContain("Irreversible migration");
    expect(p).toContain("Security surface");
  });

  test("instructs to call submit_plan_review", () => {
    const p = buildPlanReviewPrompt(1, "PRD", [{ id: 10, body: "body" }]);
    expect(p).toContain("submit_plan_review");
  });

  test("handles empty children list gracefully", () => {
    const p = buildPlanReviewPrompt(1, "PRD with no children", []);
    expect(p).toContain("PRD with no children");
    expect(p).toContain("no child items found");
    expect(p).toContain("escalate");
  });

  test("includes child count in heading", () => {
    const p = buildPlanReviewPrompt(1, "PRD", [
      { id: 1, body: "one" },
      { id: 2, body: "two" },
      { id: 3, body: "three" },
    ]);
    expect(p).toContain("3 total");
  });

  test("includes the actual parent issue number in the PRD heading", () => {
    const p = buildPlanReviewPrompt(42, "PRD body", [{ id: 10, body: "child" }]);
    expect(p).toContain("## Parent PRD (#42)");
    expect(p).not.toContain("#parent");
  });
});

// ── Agent behaviour (fake session) ──────────────────────────────────────────

/** Shape the plan-reviewer's tool handler expects — mirror of PlanReviewVerdict
 *  but with string keys for childAgentReady (the tool uses Type.Record(String)). */
interface ToolVerdict {
  decision: "CLEAR" | "ESCALATE";
  risks: string[];
  childAgentReady: Record<string, { pass: boolean; reason?: string }>;
}

describe("PiPlanReviewer.review", () => {
  function reviewer(opts: { submit?: ToolVerdict; key?: boolean; submitOnCall?: number }) {
    let toolsSeen: readonly string[] | undefined;
    let promptCalls = 0;
    const rev = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials(opts.key === false ? {} : { openai: "sk" }),
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return `body of #${args[2]}`;
        }
        if (args[0] === "api" && args[1] === "--paginate") {
          return JSON.stringify([
            { number: 10, body: "child 10\nParent: #1" },
            { number: 11, body: "child 11\nParent: #1" },
          ]);
        }
        return "";
      },
      sessionFactory: async (sopts) => {
        toolsSeen = sopts.tools as readonly string[] | undefined;
        return {
          prompt: async () => {
            promptCalls++;
            // Simulate the plan-reviewer calling submit_plan_review on the
            // configured prompt (1st call by default; 2nd = after the nudge).
            // Cast via unknown — the SDK's wrapped execute carries extra context
            // args our handler ignores (same pattern as pi-reviewer.test.ts).
            const tool = sopts.customTools?.[0];
            if (
              opts.submit !== undefined &&
              tool !== undefined &&
              promptCalls === (opts.submitOnCall ?? 1)
            ) {
              const exec = tool.execute as unknown as (
                id: string,
                p: ToolVerdict,
              ) => Promise<unknown>;
              await exec("call-1", opts.submit);
            }
            return ZERO_SLICE_COST;
          },
        };
      },
    });
    return { rev, tools: () => toolsSeen };
  }

  const clearVerdict: ToolVerdict = {
    decision: "CLEAR",
    risks: [],
    childAgentReady: { "10": { pass: true }, "11": { pass: true } },
  };

  const escalateVerdict: ToolVerdict = {
    decision: "ESCALATE",
    risks: ["security surface: child 10 touches auth middleware"],
    childAgentReady: {
      "10": { pass: false, reason: "auth changes unaccounted" },
      "11": { pass: true },
    },
  };

  test("returns a CLEAR verdict when the agent submits CLEAR", async () => {
    const { rev } = reviewer({ submit: clearVerdict });
    const result = await rev.review(1);
    expect(result.decision).toBe("CLEAR");
    expect(result.risks).toEqual([]);
    expect(result.childAgentReady[10]?.pass).toBe(true);
    expect(result.childAgentReady[11]?.pass).toBe(true);
  });

  test("returns an ESCALATE verdict with named risks", async () => {
    const { rev } = reviewer({ submit: escalateVerdict });
    const result = await rev.review(1);
    expect(result.decision).toBe("ESCALATE");
    expect(result.risks).toContain("security surface: child 10 touches auth middleware");
    expect(result.childAgentReady[10]?.pass).toBe(false);
    expect(result.childAgentReady[10]?.reason).toBe("auth changes unaccounted");
  });

  test("nudges and captures a verdict submitted only after the nudge", async () => {
    const { rev } = reviewer({
      submit: clearVerdict,
      submitOnCall: 2,
    });
    const result = await rev.review(1);
    expect(result.decision).toBe("CLEAR");
  });

  test("fails safe to ESCALATE when no verdict is submitted even after the nudge", async () => {
    const { rev } = reviewer({});
    const result = await rev.review(1);
    expect(result.decision).toBe("ESCALATE");
    expect(result.risks).toContain("Plan review agent did not submit a verdict");
    expect(result.childAgentReady).toEqual({});
  });

  test("allowlists read-only tools + submit_plan_review (no bash/write)", async () => {
    const { rev, tools } = reviewer({ submit: clearVerdict });
    await rev.review(1);
    expect(tools()).toEqual([...PLAN_REVIEW_TOOLS, PLAN_VERDICT_TOOL]);
    expect(tools()).not.toContain("bash");
    expect(tools()).not.toContain("write");
    expect(tools()).not.toContain("edit");
  });

  test("listChildren uses gh api --paginate (not issue list --limit)", async () => {
    const calls: string[][] = [];
    const rev = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials({ openai: "sk" }),
      gh: async (args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "view") return "body";
        if (args[0] === "api" && args[1] === "--paginate") {
          return JSON.stringify([{ number: 10, body: "child\nParent: #1" }]);
        }
        return "";
      },
      sessionFactory: async (sopts) => ({
        prompt: async () => {
          const tool = sopts.customTools?.[0];
          if (tool) {
            const exec = tool.execute as unknown as (
              id: string,
              p: ToolVerdict,
            ) => Promise<unknown>;
            await exec("c", {
              decision: "CLEAR",
              risks: [],
              childAgentReady: { "10": { pass: true } },
            });
          }
          return ZERO_SLICE_COST;
        },
      }),
    });
    await rev.review(1);
    const listCall = calls.find((a) => a[0] === "api" && a[1] === "--paginate");
    expect(listCall).toBeDefined();
    expect(listCall?.[2]).toContain("repos/o/r/issues");
    // Must NOT fall back to the old `gh issue list` approach
    expect(calls.every((a) => !(a[0] === "issue" && a[1] === "list"))).toBe(true);
  });

  test("listChildren returns children beyond the first 1000 (no silent cap)", async () => {
    // Simulate gh api --paginate returning a combined 1200-item array (what the
    // CLI merges from multiple pages). All matching children must be found.
    const allIssues = Array.from({ length: 1200 }, (_, i) => ({
      number: i + 1,
      body: i >= 999 ? "child\nParent: #77" : "unrelated",
    }));
    // Verify that review() attempts to fetch bodies for issues beyond index 999
    // (i.e. #1000+) — something the old --limit 1000 cap would have silently dropped.
    const viewedIds: number[] = [];
    const rev2 = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials({ openai: "sk" }),
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          viewedIds.push(Number(args[2]));
          return "prd body";
        }
        if (args[0] === "api" && args[1] === "--paginate") return JSON.stringify(allIssues);
        return "";
      },
      sessionFactory: async (sopts) => ({
        prompt: async () => {
          const tool = sopts.customTools?.[0];
          if (tool) {
            const exec = tool.execute as unknown as (
              id: string,
              p: ToolVerdict,
            ) => Promise<unknown>;
            const ready: Record<string, { pass: boolean }> = {};
            for (const id of viewedIds.filter((n) => n !== 77)) ready[String(id)] = { pass: true };
            await exec("c", { decision: "CLEAR", risks: [], childAgentReady: ready });
          }
          return ZERO_SLICE_COST;
        },
      }),
    });
    await rev2.review(77);
    // Issues 1000–1200 have `Parent: #77`; all should have been fetched.
    const childIds = viewedIds.filter((n) => n !== 77);
    expect(childIds.length).toBe(201); // indices 999..1199 => numbers 1000..1200
    expect(childIds).toContain(1000);
    expect(childIds).toContain(1200);
  });

  test("listChildren finds children written with a ## Parent heading (to-issues form)", async () => {
    // Regression: issues created by /to-issues write '## Parent\n\n#<n>' not 'Parent: #<n>'.
    // parseParent handles both forms; the old substring match missed this.
    const viewedIds: number[] = [];
    const rev = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials({ openai: "sk" }),
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          viewedIds.push(Number(args[2]));
          return "body";
        }
        if (args[0] === "api" && args[1] === "--paginate") {
          return JSON.stringify([
            // heading form produced by /to-issues
            { number: 10, body: "## Parent\n\n#42\n\nsome body" },
            // inline form produced by flowd slicer
            { number: 11, body: "some body\nParent: #42" },
            // heading with a different parent — must NOT be included
            { number: 20, body: "## Parent\n\n#99\n\nother" },
            // completely unrelated
            { number: 30, body: "no parent marker here" },
          ]);
        }
        return "";
      },
      sessionFactory: async (sopts) => ({
        prompt: async () => {
          const tool = sopts.customTools?.[0];
          if (tool) {
            const exec = tool.execute as unknown as (
              id: string,
              p: ToolVerdict,
            ) => Promise<unknown>;
            await exec("c", {
              decision: "CLEAR",
              risks: [],
              childAgentReady: { "10": { pass: true }, "11": { pass: true } },
            });
          }
          return ZERO_SLICE_COST;
        },
      }),
    });
    await rev.review(42);
    expect(viewedIds).toContain(10); // heading form
    expect(viewedIds).toContain(11); // inline form
    expect(viewedIds).not.toContain(20); // different parent
    expect(viewedIds).not.toContain(30); // no parent marker
  });

  test("listChildren excludes pull requests from REST response", async () => {
    const viewedIds: number[] = [];
    const rev = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials({ openai: "sk" }),
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          viewedIds.push(Number(args[2]));
          return "body";
        }
        if (args[0] === "api" && args[1] === "--paginate") {
          return JSON.stringify([
            { number: 10, body: "child\nParent: #1" }, // issue — keep
            { number: 20, body: "PR child\nParent: #1", pull_request: { url: "https://..." } }, // PR — drop
            { number: 30, body: "other" }, // unrelated — skip
          ]);
        }
        return "";
      },
      sessionFactory: async (sopts) => ({
        prompt: async () => {
          const tool = sopts.customTools?.[0];
          if (tool) {
            const exec = tool.execute as unknown as (
              id: string,
              p: ToolVerdict,
            ) => Promise<unknown>;
            await exec("c", {
              decision: "CLEAR",
              risks: [],
              childAgentReady: { "10": { pass: true } },
            });
          }
          return ZERO_SLICE_COST;
        },
      }),
    });
    await rev.review(1);
    expect(viewedIds).toContain(10); // the real issue child
    expect(viewedIds).not.toContain(20); // the PR must be excluded
    expect(viewedIds).not.toContain(30); // unrelated
  });

  test("throws without an API key", async () => {
    const { rev } = reviewer({ key: false });
    await expect(rev.review(1)).rejects.toThrow(/no API key/);
  });

  test("fetches the parent PRD and child bodies via gh", async () => {
    const bodies: string[] = [];
    const rev = new PiPlanReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials({ openai: "sk" }),
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          bodies.push(`view:${args[2]}`);
          return `body #${args[2]}`;
        }
        if (args[0] === "api" && args[1] === "--paginate") {
          return JSON.stringify([
            { number: 10, body: "c10\nParent: #1" },
            { number: 11, body: "c11\nParent: #1" },
            { number: 99, body: "other" },
          ]);
        }
        return "";
      },
      sessionFactory: async (sopts) => {
        return {
          prompt: async () => {
            // Immediately call submit_plan_review with a CLEAR verdict.
            const tool = sopts.customTools?.[0];
            if (tool !== undefined) {
              const exec = tool.execute as unknown as (
                id: string,
                p: ToolVerdict,
              ) => Promise<unknown>;
              await exec("call-1", {
                decision: "CLEAR",
                risks: [],
                childAgentReady: { "10": { pass: true }, "11": { pass: true } },
              });
            }
            return ZERO_SLICE_COST;
          },
        };
      },
    });
    await rev.review(1);
    expect(bodies).toContain("view:1");
    expect(bodies).toContain("view:10");
    expect(bodies).toContain("view:11");
    expect(bodies).not.toContain("view:99");
  });
});
