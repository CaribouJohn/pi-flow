import { describe, expect, test } from "bun:test";
import type { FlowdConfig } from "../src/config.ts";
import { assertWorkdirIsolated, buildPorts, makeVerifyGate } from "../src/flow-run.ts";
import { makeCredentials } from "./helpers.ts";

describe("assertWorkdirIsolated (leak guard)", () => {
  test("rejects a workdir nested inside the repo", () => {
    expect(() => assertWorkdirIsolated("/repo/.flowd-workdir", "/repo")).toThrow(
      /OUTSIDE the operated repo/,
    );
  });
  test("rejects the repo root itself", () => {
    expect(() => assertWorkdirIsolated("/repo", "/repo")).toThrow(/inside the repo/);
  });
  test("accepts a workdir outside the repo", () => {
    expect(() => assertWorkdirIsolated("/work/flowd", "/repo")).not.toThrow();
  });
  test("accepts a sibling sharing a name prefix (not a real ancestor)", () => {
    expect(() => assertWorkdirIsolated("/repo-sandbox", "/repo")).not.toThrow();
  });
});

describe("makeVerifyGate", () => {
  test("green when the command exits 0", async () => {
    const gate = makeVerifyGate("/wd", "whatever", async () => 0);
    expect(await gate.run(1)).toEqual({ green: true });
  });
  test("red when the command exits non-zero", async () => {
    const gate = makeVerifyGate("/wd", "whatever", async () => 1);
    expect(await gate.run(1)).toEqual({ green: false });
  });
  test("runs the configured command in the workdir", async () => {
    let seen: { cmd: string; cwd: string } | undefined;
    const gate = makeVerifyGate("/wd", "bun run verify", async (cmd, cwd) => {
      seen = { cmd, cwd };
      return 0;
    });
    await gate.run(1);
    expect(seen).toEqual({ cmd: "bun run verify", cwd: "/wd" });
  });
});

describe("buildPorts", () => {
  const config: FlowdConfig = {
    repo: "o/r",
    defaultBranch: "main",
    trackBranch: "track/x",
    workdir: "/wd",
    actor: "flow-bot",
    aiDisclaimer: "[ai]",
    reviewerIterationCap: 2,
    verifyCommand: "bun run verify",
    credentialsPath: "/c.json",
    models: {
      implement: { provider: "anthropic", id: "claude-opus-4-8" },
      review: { provider: "openai", id: "gpt-5" },
      slice: { provider: "anthropic", id: "claude-opus-4-8" },
      planReview: { provider: "openai", id: "gpt-5" },
    },
    costEstimator: {
      reworkMultiplier: 1.3,
      effortTokens: {
        low: { implement: 1000, review: 500 },
        medium: { implement: 3000, review: 1500 },
        high: { implement: 10000, review: 4000 },
      },
      modelPrices: {
        cheap: 3.0,
        mid: 10.0,
        strong: 50.0,
      },
      effortToModel: {
        low: { implement: "cheap", review: "strong" },
        medium: { implement: "mid", review: "strong" },
        high: { implement: "strong", review: "strong" },
      },
    },
  };

  test("composes all four engine ports", () => {
    const ports = buildPorts(config, makeCredentials({}), "ghp_fake_test_token");
    expect(typeof ports.tracker.listSlices).toBe("function");
    expect(typeof ports.forge.driftRefresh).toBe("function");
    expect(typeof ports.agent.implement).toBe("function");
    expect(typeof ports.agent.review).toBe("function");
    expect(typeof ports.agent.planReview).toBe("function");
    expect(typeof ports.verify.run).toBe("function");
  });
});
