import { describe, expect, test } from "bun:test";
import type { FlowdConfig } from "../src/config.ts";
import { buildPorts, makeVerifyGate } from "../src/flow-run.ts";
import { makeCredentials } from "./helpers.ts";

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
    },
  };

  test("composes all four engine ports", () => {
    const ports = buildPorts(config, makeCredentials({}));
    expect(typeof ports.tracker.listSlices).toBe("function");
    expect(typeof ports.forge.driftRefresh).toBe("function");
    expect(typeof ports.agent.implement).toBe("function");
    expect(typeof ports.agent.review).toBe("function");
    expect(typeof ports.verify.run).toBe("function");
  });
});
