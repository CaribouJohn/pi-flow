/**
 * Smoke for review-spawn. Run with:
 *   bun extension/review-spawn.smoke.ts
 *
 * Pure helpers + reviewSpawn() with fully-mocked spawn + filesystem.
 */

import {
  buildReviewerSystemPrompt,
  buildReviewerTaskPrompt,
  parseVerdictDoc,
  reviewSpawn,
  VERDICT_VALUES,
  type ReviewVerdictDoc,
} from "./review-spawn.ts";
import {
  SPAWN_DEPTH_ENV,
  RESULT_FILE_ENV,
  TAIL_CAP,
} from "./implement-spawn.ts";
import type { SpawnPiOptions } from "./spawn-pi.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- buildReviewerSystemPrompt ---
{
  const sp = buildReviewerSystemPrompt({
    sliceBranch: "slice/b7-review-spawn",
    baseBranch: "track/afk-loop",
    prNumber: 62,
    reviewerCommand: "/code-review",
  });
  check("system prompt mentions slice branch", sp.includes("slice/b7-review-spawn"));
  check("system prompt mentions base branch", sp.includes("track/afk-loop"));
  check("system prompt mentions PR number", sp.includes("#62"));
  check("system prompt mentions reviewer command label", sp.includes("/code-review"));
  check("system prompt teaches result-file contract", sp.includes("PI_FLOW_RESULT_FILE"));
  check("system prompt names all three verdicts", sp.includes("approve") && sp.includes("changes-requested") && sp.includes("escalate"));
  check("system prompt includes gh pr diff hint", sp.includes("gh pr diff 62"));
  check("system prompt includes three-dot git diff hint", sp.includes("git diff track/afk-loop...slice/b7-review-spawn"));
  check("system prompt includes git log hint", sp.includes("git log track/afk-loop..slice/b7-review-spawn"));
  check("system prompt forbids further sub-agent spawns", sp.includes("flow_implement_spawn") && sp.includes("flow_review_spawn"));
  check("system prompt forbids file modifications", sp.toLowerCase().includes("read-only"));
  check("system prompt forbids posting PR comments", /post.*PR comments/i.test(sp));
}

{
  // no PR number: gh pr diff hint should NOT appear, git diff hint still should
  const sp = buildReviewerSystemPrompt({
    sliceBranch: "slice/x",
    baseBranch: "main",
    // prNumber omitted
  });
  check("no-PR variant omits gh pr diff hint", !sp.includes("gh pr diff"));
  check("no-PR variant still has git diff hint", sp.includes("git diff main...slice/x"));
  check("no-PR variant labels PR field as none", sp.includes("(none — pre-PR review)"));
  check("no-reviewer-command omits role label", !sp.includes("role:"));
}

// --- buildReviewerTaskPrompt ---
{
  const tp = buildReviewerTaskPrompt({
    issueNumber: 48,
    sliceBranch: "slice/b7",
    sliceBrief: "Acceptance:\n- foo\n- bar",
  });
  check("task prompt has issue number", tp.includes("#48"));
  check("task prompt has branch", tp.includes("slice/b7"));
  check("task prompt preserves brief verbatim", tp.includes("- foo") && tp.includes("- bar"));
  check("task prompt instructs writing result file", tp.includes("$PI_FLOW_RESULT_FILE"));
}

{
  // missing brief: section header should not appear
  const tp = buildReviewerTaskPrompt({ issueNumber: 1, sliceBranch: "b" });
  check("no-brief variant omits brief section", !tp.includes("## Slice brief"));
}

// --- parseVerdictDoc ---
{
  for (const v of VERDICT_VALUES) {
    const doc: ReviewVerdictDoc = { verdict: v, comments: ["one", "two"] };
    const parsed = parseVerdictDoc(JSON.stringify(doc));
    check(`parses verdict=${v}`, parsed?.verdict === v && parsed?.comments.length === 2);
  }
  check("empty comments OK", parseVerdictDoc('{"verdict":"approve","comments":[]}')?.comments.length === 0);
  check("rejects non-json", parseVerdictDoc("not json") === undefined);
  check("rejects null", parseVerdictDoc("null") === undefined);
  check("rejects array", parseVerdictDoc("[1,2,3]") === undefined);
  check(
    "rejects unknown verdict",
    parseVerdictDoc('{"verdict":"meh","comments":[]}') === undefined,
  );
  check(
    "rejects non-string verdict",
    parseVerdictDoc('{"verdict":1,"comments":[]}') === undefined,
  );
  check(
    "rejects missing comments",
    parseVerdictDoc('{"verdict":"approve"}') === undefined,
  );
  check(
    "rejects non-array comments",
    parseVerdictDoc('{"verdict":"approve","comments":"oops"}') === undefined,
  );
  check(
    "rejects non-string comment entries",
    parseVerdictDoc('{"verdict":"approve","comments":["ok",1]}') === undefined,
  );
}

// --- reviewSpawn happy path (each verdict) ---
for (const v of VERDICT_VALUES) {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const captured: { opts?: SpawnPiOptions } = {};
  const result = await reviewSpawn({
    issueNumber: 48,
    sliceBranch: "slice/b7",
    baseBranch: "track/afk-loop",
    prNumber: 99,
    sliceBrief: "review me",
    cwd: "/repo",
    currentDepth: 0,
    reviewerCommand: "/code-review",
    spawnImpl: async (opts) => {
      captured.opts = opts;
      return {
        exitCode: 0,
        wasAborted: false,
        assistantText: "wrote verdict and exiting",
        assistantTurns: 4,
        stderr: "",
        invocation: { command: "pi", args: [] },
      };
    },
    mkResultDir: () => dir,
    readResultFile: () =>
      JSON.stringify({ verdict: v, comments: [`reason for ${v}`] }),
    cleanup: () => {},
  });

  check(`happy verdict=${v}: outcome=ok`, result.outcome === "ok");
  check(`happy verdict=${v}: result populated`, result.result?.verdict === v);
  check(`happy verdict=${v}: comments preserved`, result.result?.comments[0] === `reason for ${v}`);
  check(
    `happy verdict=${v}: env bumps depth 0→1`,
    captured.opts!.env![SPAWN_DEPTH_ENV] === "1",
  );
  check(
    `happy verdict=${v}: env carries verdict file path`,
    captured.opts!.env![RESULT_FILE_ENV] === join(dir, "verdict.json"),
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- depth bump from N ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const captured: { opts?: SpawnPiOptions } = {};
  await reviewSpawn({
    issueNumber: 1,
    sliceBranch: "b",
    baseBranch: "main",
    cwd: ".",
    currentDepth: 3,
    spawnImpl: async (opts) => {
      captured.opts = opts;
      return {
        exitCode: 0,
        wasAborted: false,
        assistantText: "",
        assistantTurns: 0,
        stderr: "",
        invocation: { command: "pi", args: [] },
      };
    },
    mkResultDir: () => dir,
    readResultFile: () => JSON.stringify({ verdict: "approve", comments: [] }),
    cleanup: () => {},
  });
  check("depth bump 3 → 4", captured.opts!.env![SPAWN_DEPTH_ENV] === "4");
  rmSync(dir, { recursive: true, force: true });
}

// --- failure paths ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const r = await reviewSpawn({
    issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 0, wasAborted: false, assistantText: "done", assistantTurns: 1,
      stderr: "", invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("no verdict file → outcome=no_result_file", r.outcome === "no_result_file");
  check("no verdict file → reason mentions verdict.json", !!r.reason && r.reason.includes("verdict.json"));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const r = await reviewSpawn({
    issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 0, wasAborted: false, assistantText: "", assistantTurns: 1,
      stderr: "", invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => '{"verdict":"yes please"}',
    cleanup: () => {},
  });
  check("malformed verdict → outcome=bad_result_file", r.outcome === "bad_result_file");
  check("malformed verdict → reason includes raw prefix", !!r.reason && r.reason.includes("yes please"));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const r = await reviewSpawn({
    issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 9, wasAborted: false, assistantText: "crashed", assistantTurns: 1,
      stderr: "boom", invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("exit 9 → outcome=spawn_failed", r.outcome === "spawn_failed");
  check("exit 9 → exitCode preserved", r.exitCode === 9);
  check("spawn_failed → stderr captured", r.stderrTail === "boom");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const r = await reviewSpawn({
    issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 143, wasAborted: true, assistantText: "", assistantTurns: 0,
      stderr: "", invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("aborted → outcome=aborted", r.outcome === "aborted");
  check("aborted → wasAborted=true", r.wasAborted === true);
  rmSync(dir, { recursive: true, force: true });
}

// --- cleanup runs on spawn throw ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  let cleanupCalled = false;
  let threw: Error | undefined;
  try {
    await reviewSpawn({
      issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
      spawnImpl: async () => { throw new Error("spawn blew up"); },
      mkResultDir: () => dir,
      readResultFile: () => undefined,
      cleanup: () => { cleanupCalled = true; },
    });
  } catch (err) {
    threw = err as Error;
  }
  check("spawn throw propagates", threw?.message === "spawn blew up");
  check("cleanup ran via finally", cleanupCalled);
  rmSync(dir, { recursive: true, force: true });
}

// --- real-fs system-prompt file actually written ---
{
  const r = await reviewSpawn({
    issueNumber: 48,
    sliceBranch: "slice/smoke",
    baseBranch: "main",
    prNumber: 100,
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async (opts) => {
      const content = await import("node:fs").then((m) =>
        m.readFileSync(opts.systemPromptFile!, "utf8"),
      );
      check("real-fs: system prompt file exists on disk", content.includes("PI_FLOW_RESULT_FILE"));
      check("real-fs: system prompt has slice branch", content.includes("slice/smoke"));
      check("real-fs: system prompt has PR number", content.includes("gh pr diff 100"));
      return {
        exitCode: 0, wasAborted: false, assistantText: "ok", assistantTurns: 1,
        stderr: "", invocation: { command: "pi", args: [] },
      };
    },
    readResultFile: () => JSON.stringify({ verdict: "approve", comments: [] }),
  });
  check("real-fs path returns ok", r.outcome === "ok");
}

// --- tail wired in for big outputs ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const huge = "z".repeat(TAIL_CAP + 100);
  const r = await reviewSpawn({
    issueNumber: 1, sliceBranch: "b", baseBranch: "m", cwd: ".", currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 0, wasAborted: false,
      assistantText: huge, assistantTurns: 1, stderr: huge,
      invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => JSON.stringify({ verdict: "approve", comments: [] }),
    cleanup: () => {},
  });
  check("big assistantText truncated", r.assistantTail.includes("truncated 100 chars"));
  check("big stderr truncated", r.stderrTail.includes("truncated 100 chars"));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
