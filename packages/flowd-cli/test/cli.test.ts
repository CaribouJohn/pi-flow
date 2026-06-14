import { describe, expect, test } from "bun:test";
import { parseArgs, run } from "../src/cli.ts";

describe("parseArgs", () => {
  test("parses a command and --track", () => {
    expect(parseArgs(["run", "--track", "7"])).toEqual({ command: "run", track: 7 });
  });

  test("track is undefined when the flag is absent", () => {
    expect(parseArgs(["run"])).toEqual({ command: "run", track: undefined });
  });
});

describe("run", () => {
  test("a missing command is a usage error", () => {
    expect(run([]).code).toBe(2);
  });

  test("run without --track is a usage error", () => {
    expect(run(["run"]).code).toBe(2);
  });

  test("a valid run exits cleanly as a not-implemented stub", () => {
    const result = run(["run", "--track", "1"]);
    expect(result.code).toBe(0);
    expect(result.message).toContain("not implemented");
  });
});
