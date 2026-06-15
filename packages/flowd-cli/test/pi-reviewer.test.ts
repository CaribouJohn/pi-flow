import { describe, expect, test } from "bun:test";
import type { Verdict } from "@pi-flow/flow-engine";
import { PiReviewer, REVIEWER_TOOLS, buildReviewPrompt } from "../src/pi-reviewer.ts";
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
  function reviewer(opts: { submit?: Verdict; key?: boolean }) {
    let toolsSeen: readonly string[] | undefined;
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
            // Simulate the reviewer calling the real submit_verdict tool. Cast to
            // a 2-arg call (the SDK's wrapped execute carries extra context args
            // our handler ignores).
            const tool = sopts.customTools?.[0];
            if (opts.submit !== undefined && tool !== undefined) {
              const exec = tool.execute as unknown as (id: string, p: Verdict) => Promise<unknown>;
              await exec("call-1", opts.submit);
            }
          },
        };
      },
    });
    return { rev, tools: () => toolsSeen };
  }

  test("returns the verdict the reviewer submits (APPROVE)", async () => {
    const { rev } = reviewer({ submit: { decision: "APPROVE", findings: [] } });
    expect(await rev.review({ sliceId: 2, branch: "slice/2" })).toEqual({
      decision: "APPROVE",
      findings: [],
    });
  });

  test("returns REQUEST_CHANGES with findings", async () => {
    const v: Verdict = { decision: "REQUEST_CHANGES", findings: ["dropped a null check"] };
    const { rev } = reviewer({ submit: v });
    expect(await rev.review({ sliceId: 2, branch: "slice/2" })).toEqual(v);
  });

  test("fails safe to REQUEST_CHANGES when no verdict is submitted", async () => {
    const { rev } = reviewer({});
    const r = await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(r.decision).toBe("REQUEST_CHANGES");
    expect(r.findings.join(" ")).toContain("did not submit");
  });

  test("runs with read-only tools (no bash/write)", async () => {
    const { rev, tools } = reviewer({ submit: { decision: "APPROVE", findings: [] } });
    await rev.review({ sliceId: 2, branch: "slice/2" });
    expect(tools()).toEqual([...REVIEWER_TOOLS]);
    expect(tools()).not.toContain("bash");
    expect(tools()).not.toContain("write");
  });

  test("throws without an API key", async () => {
    const { rev } = reviewer({ key: false });
    await expect(rev.review({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no API key/);
  });
});
