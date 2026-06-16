import { describe, expect, test } from "bun:test";
import type { CredentialStore } from "../src/credentials.ts";
import { PiImplementer, buildImplementPrompt } from "../src/pi-implementer.ts";
import { makeCredentials } from "./helpers.ts";

const MODEL = { provider: "anthropic", id: "claude-opus-4-8" };

describe("buildImplementPrompt", () => {
  test("includes the brief", () => {
    expect(buildImplementPrompt("add add(a,b)", "bun run verify")).toContain("add add(a,b)");
  });
  test("includes the exact verify command and forbids a subset (#144)", () => {
    const p = buildImplementPrompt("brief", "bun run verify");
    expect(p).toContain("bun run verify");
    expect(p).toContain("not a self-chosen subset");
  });
  test("appends prior review findings when present", () => {
    const p = buildImplementPrompt("brief", "bun run verify", ["handle zero", "add a test"]);
    expect(p).toContain("previous review");
    expect(p).toContain("- handle zero");
    expect(p).toContain("- add a test");
  });
});

describe("PiImplementer.implement", () => {
  function harness(creds: CredentialStore) {
    const prompts: string[] = [];
    const commits: string[] = [];
    const checkouts: string[] = [];
    let sessionCwd: string | undefined;
    const impl = new PiImplementer({
      repo: "o/r",
      workdir: "/wd",
      trackBranch: "track/x",
      verifyCommand: "bun run verify",
      model: MODEL,
      credentials: creds,
      sessionFactory: async (opts) => {
        sessionCwd = opts.cwd;
        return {
          prompt: async (t) => {
            prompts.push(t);
          },
        };
      },
      gh: async (args) => (args[0] === "issue" ? "the slice brief" : ""),
      commit: async (_wd, msg) => {
        commits.push(msg);
        return true;
      },
      checkout: async (_wd, branch) => {
        checkouts.push(branch);
      },
      hasCommitsAhead: async () => false,
    });
    return { impl, prompts, commits, checkouts, cwd: () => sessionCwd };
  }

  test("checks out the slice branch, prompts in the workdir, and commits", async () => {
    const h = harness(makeCredentials({ anthropic: "sk" }));
    await h.impl.implement({ sliceId: 2, branch: "slice/2" });
    expect(h.checkouts).toEqual(["slice/2"]); // worked on the slice branch
    expect(h.cwd()).toBe("/wd"); // session ran in the workdir
    expect(h.prompts[0]).toContain("the slice brief");
    expect(h.commits[0]).toContain("slice #2");
  });

  test("throws when the provider has no API key", async () => {
    const { impl } = harness(makeCredentials({}));
    await expect(impl.implement({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no API key/);
  });

  test("throws when the slice is genuinely empty (no commit, nothing ahead)", async () => {
    const impl = new PiImplementer({
      repo: "o/r",
      workdir: "/wd",
      trackBranch: "track/x",
      verifyCommand: "bun run verify",
      model: MODEL,
      credentials: makeCredentials({ anthropic: "sk" }),
      sessionFactory: async () => ({ prompt: async () => {} }),
      gh: async () => "brief",
      commit: async () => false,
      checkout: async () => {},
      hasCommitsAhead: async () => false,
    });
    await expect(impl.implement({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no changes/);
  });

  test("succeeds when a prior run already implemented the slice (idempotent re-entry)", async () => {
    const impl = new PiImplementer({
      repo: "o/r",
      workdir: "/wd",
      trackBranch: "track/x",
      verifyCommand: "bun run verify",
      model: MODEL,
      credentials: makeCredentials({ anthropic: "sk" }),
      sessionFactory: async () => ({ prompt: async () => {} }),
      gh: async () => "brief",
      commit: async () => false, // agent made no new changes — already done
      checkout: async () => {},
      hasCommitsAhead: async () => true, // but the branch already carries the work
    });
    await expect(impl.implement({ sliceId: 2, branch: "slice/2" })).resolves.toBeUndefined();
  });
});
