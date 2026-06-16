import { describe, expect, test } from "bun:test";
import { type Verdict, ZERO_SLICE_COST } from "@pi-flow/flow-engine";
import { PiReviewer, REVIEWER_TOOLS, VERDICT_TOOL, buildReviewPrompt } from "../src/pi-reviewer.ts";
import { makeCredentials } from "./helpers.ts";

const MODEL = { provider: "openai", id: "gpt-5" };

describe("buildReviewPrompt", () => {
  test("includes the diff and the submit_verdict instruction", () => {
    const p = buildReviewPrompt("THE DIFF");
    expect(p).toContain("THE DIFF");
    expect(p).toContain("submit_verdict");
    expect(p).toContain("ADVERSARIAL");
  });
});

describe("PiReviewer.review", () => {
  function reviewer(opts: { submit?: Verdict; key?: boolean; submitOnCall?: number }) {
    let toolsSeen: readonly string[] | undefined;
    let promptCalls = 0;
    const rev = new PiReviewer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: makeCredentials(opts.key === false ? {} : { openai: "sk" }),
      gh: async (args) => (args[1] === "diff" ? "the diff" : ""),
      checkout: async () => {},
      sessionFactory: async (sopts) => {
        toolsSeen = sopts.tools as readonly string[] | undefined;
        return {
          prompt: async () => {
            promptCalls++;
            // Simulate the reviewer calling the real submit_verdict tool on the
            // configured prompt (call 1 by default; 2 = only after the nudge).
            // Cast to a 2-arg call (the SDK's wrapped execute carries extra
            // context args our handler ignores).
            const tool = sopts.customTools?.[0];
            if (
              opts.submit !== undefined &&
              tool !== undefined &&
              promptCalls === (opts.submitOnCall ?? 1)
            ) {
              const exec = tool.execute as unknown as (id: string, p: Verdict) => Promise<unknown>;
              await exec("call-1", opts.submit);
            }
            return ZERO_SLICE_COST;
          },
        };
      },
    });
    return { rev, tools: () => toolsSeen };
  }

  test("returns the verdict the reviewer submits (APPROVE)", async () => {
    const { rev } = reviewer({ submit: { decision: "APPROVE", findings: [] } });
    const result = await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(result.verdict).toEqual({ decision: "APPROVE", findings: [] });
    expect(result.cost).toBeDefined();
  });

  test("returns REQUEST_CHANGES with findings", async () => {
    const v: Verdict = { decision: "REQUEST_CHANGES", findings: ["dropped a null check"] };
    const { rev } = reviewer({ submit: v });
    const result = await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(result.verdict).toEqual(v);
  });

  test("nudges and captures a verdict submitted only after the nudge", async () => {
    const { rev } = reviewer({ submit: { decision: "APPROVE", findings: [] }, submitOnCall: 2 });
    const result = await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(result.verdict).toEqual({ decision: "APPROVE", findings: [] });
  });

  test("fails safe to REQUEST_CHANGES when no verdict is submitted even after the nudge", async () => {
    const { rev } = reviewer({});
    const r = await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(r.verdict.decision).toBe("REQUEST_CHANGES");
    expect(r.verdict.findings.join(" ")).toContain("did not submit");
  });

  test("allowlists read-only tools + submit_verdict (no bash/write)", async () => {
    const { rev, tools } = reviewer({ submit: { decision: "APPROVE", findings: [] } });
    await rev.review({ sliceId: 2, branch: "slice/2" });
    // submit_verdict MUST be allowlisted or the reviewer can't report (the bug
    // that caused "reviewer did not submit a verdict").
    expect(tools()).toEqual([...REVIEWER_TOOLS, VERDICT_TOOL]);
    expect(tools()).not.toContain("bash");
    expect(tools()).not.toContain("write");
  });

  test("throws without an API key", async () => {
    const { rev } = reviewer({ key: false });
    await expect(rev.review({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no API key/);
  });
});
