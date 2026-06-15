import { describe, expect, test } from "bun:test";
import {
  SLICER_TOOLS,
  SLICE_PLAN_NUDGE,
  SLICE_PLAN_TOOL,
  buildSlicePrompt,
} from "../src/pi-slicer.ts";

describe("buildSlicePrompt", () => {
  test("includes the parent issue number and PRD content", () => {
    const prd = "# Feature PRD\n\nBuild a login system.";
    const prompt = buildSlicePrompt(42, prd);

    expect(prompt).toContain("#42");
    expect(prompt).toContain(prd);
    expect(prompt).toContain("submit_slice_plan");
    expect(prompt).toContain("decomposition agent");
  });

  test("includes slicing rules", () => {
    const prompt = buildSlicePrompt(1, "test");
    expect(prompt).toContain("Tracer-bullet vertical slices");
    expect(prompt).toContain("effort:high is an escalation trigger");
    expect(prompt).toContain("DAG");
  });

  test("handles empty PRD gracefully", () => {
    const prompt = buildSlicePrompt(1, "");
    expect(prompt).toContain("## Parent PRD (#1)");
  });

  test("handles large PRDs", () => {
    const largePrd = "x".repeat(10000);
    const prompt = buildSlicePrompt(1, largePrd);
    expect(prompt).toContain(largePrd);
  });
});

describe("SLICER_TOOLS", () => {
  test("includes only read-only tools (no write/bash)", () => {
    expect(SLICER_TOOLS).toContain("read");
    expect(SLICER_TOOLS).toContain("grep");
    expect(SLICER_TOOLS).toContain("find");
    expect(SLICER_TOOLS).toContain("ls");
    expect(SLICER_TOOLS).not.toContain("write");
    expect(SLICER_TOOLS).not.toContain("edit");
    expect(SLICER_TOOLS).not.toContain("bash");
  });
});

describe("SLICE_PLAN_TOOL", () => {
  test("is a constant string", () => {
    expect(SLICE_PLAN_TOOL).toBe("submit_slice_plan");
  });
});

describe("SLICE_PLAN_NUDGE", () => {
  test("references the tool name", () => {
    expect(SLICE_PLAN_NUDGE).toContain("submit_slice_plan");
  });

  test("tells the model not to answer in prose", () => {
    expect(SLICE_PLAN_NUDGE.toLowerCase()).toContain("do not answer in prose");
  });
});
