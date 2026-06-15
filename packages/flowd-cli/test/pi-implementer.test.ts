import { describe, expect, test } from "bun:test";
import type { CredentialStore } from "../src/credentials.ts";
import { PiImplementer, buildImplementPrompt } from "../src/pi-implementer.ts";
import { makeCredentials } from "./helpers.ts";

const MODEL = { provider: "anthropic", id: "claude-opus-4-8" };

describe("buildImplementPrompt", () => {
  test("includes the brief", () => {
    expect(buildImplementPrompt("add add(a,b)")).toContain("add add(a,b)");
  });
  test("appends prior review findings when present", () => {
    const p = buildImplementPrompt("brief", ["handle zero", "add a test"]);
    expect(p).toContain("previous review");
    expect(p).toContain("- handle zero");
    expect(p).toContain("- add a test");
  });
});

describe("PiImplementer.implement", () => {
  function harness(creds: CredentialStore) {
    const prompts: string[] = [];
    const commits: string[] = [];
    const impl = new PiImplementer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: creds,
      sessionFactory: async () => ({
        prompt: async (t) => {
          prompts.push(t);
        },
      }),
      gh: async (args) => (args[0] === "issue" ? "the slice brief" : ""),
      commit: async (_wd, msg) => {
        commits.push(msg);
        return true;
      },
    });
    return { impl, prompts, commits };
  }

  test("fetches the brief, prompts the session, and commits", async () => {
    const { impl, prompts, commits } = harness(makeCredentials({ anthropic: "sk" }));
    await impl.implement({ sliceId: 2, branch: "slice/2" });
    expect(prompts[0]).toContain("the slice brief");
    expect(commits[0]).toContain("slice #2");
  });

  test("throws when the provider has no API key", async () => {
    const { impl } = harness(makeCredentials({}));
    await expect(impl.implement({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no API key/);
  });

  test("throws when the implementer made no changes (empty commit)", async () => {
    const creds = makeCredentials({ anthropic: "sk" });
    const impl = new PiImplementer({
      repo: "o/r",
      workdir: "/wd",
      model: MODEL,
      credentials: creds,
      sessionFactory: async () => ({ prompt: async () => {} }),
      gh: async () => "brief",
      commit: async () => false,
    });
    await expect(impl.implement({ sliceId: 2, branch: "slice/2" })).rejects.toThrow(/no changes/);
  });
});
