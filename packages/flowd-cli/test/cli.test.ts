import { describe, expect, test } from "bun:test";
import { parseArgs, planInvocation } from "../src/cli.ts";

describe("parseArgs", () => {
  test("parses a command, --track, and --config", () => {
    expect(parseArgs(["run", "--track", "7", "--config", "c.json"])).toEqual({
      command: "run",
      track: 7,
      config: "c.json",
    });
  });

  test("track/config undefined when absent", () => {
    expect(parseArgs(["run"])).toEqual({ command: "run", track: undefined, config: undefined });
  });

  test("track is undefined when --track has no value", () => {
    expect(parseArgs(["run", "--track"])).toEqual({
      command: "run",
      track: undefined,
      config: undefined,
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
});
