import { describe, expect, test } from "bun:test";
import { parseArgs, planInvocation } from "../src/cli.ts";

describe("parseArgs", () => {
  test("parses a command, --track, and --config", () => {
    expect(parseArgs(["run", "--track", "7", "--config", "c.json"])).toEqual({
      command: "run",
      track: 7,
      issue: undefined,
      prd: undefined,
      reason: undefined,
      config: "c.json",
    });
  });

  test("track/config undefined when absent", () => {
    expect(parseArgs(["run"])).toEqual({
      command: "run",
      track: undefined,
      issue: undefined,
      prd: undefined,
      reason: undefined,
      config: undefined,
    });
  });

  test("track is undefined when --track has no value", () => {
    expect(parseArgs(["run", "--track"])).toEqual({
      command: "run",
      track: undefined,
      issue: undefined,
      prd: undefined,
      reason: undefined,
      config: undefined,
    });
  });

  test("parses plan command with --issue and --prd", () => {
    expect(parseArgs(["plan", "--issue", "5", "--prd", "docs/prd/foo.md"])).toEqual({
      command: "plan",
      track: undefined,
      issue: 5,
      prd: "docs/prd/foo.md",
      reason: undefined,
      config: undefined,
    });
  });

  test("parses plan with all flags", () => {
    expect(parseArgs(["plan", "--issue", "5", "--prd", "p.md", "--config", "c.json"])).toEqual({
      command: "plan",
      track: undefined,
      issue: 5,
      prd: "p.md",
      reason: undefined,
      config: "c.json",
    });
  });

  test("--issue with no value yields undefined", () => {
    // parseArgs now guards non-integer Number() results → undefined.
    expect(parseArgs(["plan", "--issue", "--prd", "p.md"])).toMatchObject({
      command: "plan",
      issue: undefined,
    });
  });
});

describe("planInvocation", () => {
  test("a missing command is a usage error", () => {
    expect(planInvocation([])).toMatchObject({ kind: "usage", code: 2 });
  });

  test.each([
    ["no --track", ["run"]],
    ["--track with no value", ["run", "--track"]],
    ["non-numeric track", ["run", "--track", "abc"]],
    ["zero track", ["run", "--track", "0"]],
    ["negative track", ["run", "--track", "-1"]],
    ["fractional track", ["run", "--track", "1.5"]],
  ])("rejects %s as a usage error", (_label, argv) => {
    expect(planInvocation(argv)).toMatchObject({ kind: "usage", code: 2 });
  });

  test("a valid invocation plans a run with the track and config", () => {
    expect(planInvocation(["run", "--track", "5", "--config", "c.json"])).toEqual({
      kind: "run",
      track: 5,
      config: "c.json",
    });
  });

  test("config is undefined when not passed (entry falls back)", () => {
    expect(planInvocation(["run", "--track", "5"])).toEqual({
      kind: "run",
      track: 5,
      config: undefined,
    });
  });

  // ── plan command ──

  test("a valid plan invocation", () => {
    expect(planInvocation(["plan", "--issue", "5", "--prd", "p.md"])).toEqual({
      kind: "plan",
      issue: 5,
      prd: "p.md",
      config: undefined,
    });
  });

  test("plan with config", () => {
    expect(planInvocation(["plan", "--issue", "5", "--prd", "p.md", "--config", "c.json"])).toEqual(
      {
        kind: "plan",
        issue: 5,
        prd: "p.md",
        config: "c.json",
      },
    );
  });

  test.each([
    ["no --issue", ["plan", "--prd", "p.md"]],
    ["--issue with no value", ["plan", "--issue", "--prd", "p.md"]],
    ["non-numeric issue", ["plan", "--issue", "abc", "--prd", "p.md"]],
    ["zero issue", ["plan", "--issue", "0", "--prd", "p.md"]],
    ["negative issue", ["plan", "--issue", "-1", "--prd", "p.md"]],
  ])("plan: rejects %s as a usage error", (_label, argv) => {
    expect(planInvocation(argv)).toMatchObject({ kind: "usage", code: 2 });
  });

  test("plan: rejects missing --prd", () => {
    expect(planInvocation(["plan", "--issue", "5"])).toMatchObject({ kind: "usage", code: 2 });
    const msg = (planInvocation(["plan", "--issue", "5"]) as { message: string }).message;
    expect(msg).toContain("--prd");
  });

  test("plan: rejects --prd with empty value", () => {
    // parseArgs yields prd: undefined when --prd has no value (eats the next flag).
    // PlanInvocation catches the undefined.
    const p = planInvocation(["plan", "--issue", "5", "--prd"]);
    expect(p).toMatchObject({ kind: "usage", code: 2 });
    if (p.kind === "usage") {
      expect(p.message).toContain("--prd");
    }
  });

  // ── accept command ──

  test("accept: valid invocation", () => {
    expect(planInvocation(["accept", "--track", "7"])).toEqual({
      kind: "accept",
      track: 7,
      config: undefined,
    });
  });

  test("accept: with --config", () => {
    expect(planInvocation(["accept", "--track", "3", "--config", "c.json"])).toEqual({
      kind: "accept",
      track: 3,
      config: "c.json",
    });
  });

  test("accept: missing --track is a usage error", () => {
    expect(planInvocation(["accept"])).toMatchObject({ kind: "usage", code: 2 });
  });

  test("accept: non-numeric track is a usage error", () => {
    expect(planInvocation(["accept", "--track", "abc"])).toMatchObject({
      kind: "usage",
      code: 2,
    });
  });

  test("accept: zero track is a usage error", () => {
    expect(planInvocation(["accept", "--track", "0"])).toMatchObject({
      kind: "usage",
      code: 2,
    });
  });
});
