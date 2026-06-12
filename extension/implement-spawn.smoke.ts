/**
 * Smoke for implement-spawn. Run with:
 *   bun extension/implement-spawn.smoke.ts
 *
 * Pure helpers + the implementSpawn entry point with a fully-mocked
 * spawn + filesystem (no real `pi` invocation, no real disk writes
 * except the system-prompt file which lands in a DI'd temp dir).
 */

import {
  buildImplementerSystemPrompt,
  buildImplementerTaskPrompt,
  parseResultDoc,
  tail,
  currentSpawnDepth,
  implementSpawn,
  SPAWN_DEPTH_ENV,
  RESULT_FILE_ENV,
  TAIL_CAP,
  type ImplementResultDoc,
} from "./implement-spawn.ts";
import type { SpawnPiOptions, SpawnPiResult } from "./spawn-pi.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// --- buildImplementerSystemPrompt ---
{
  const sp = buildImplementerSystemPrompt({
    branch: "slice/b6-implement-spawn",
    verifyGate: "bunx tsc --noEmit",
  });
  check("system prompt mentions branch", sp.includes("slice/b6-implement-spawn"));
  check("system prompt mentions verify gate", sp.includes("bunx tsc --noEmit"));
  check("system prompt teaches result-file contract", sp.includes("PI_FLOW_RESULT_FILE"));
  check(
    "system prompt forbids further sub-agent spawns",
    sp.includes("flow_implement_spawn") && sp.includes("flow_review_spawn"),
  );
  check("system prompt forbids opening PR", /push.*PR|open a PR/.test(sp));
}

// --- buildImplementerTaskPrompt ---
{
  const tp = buildImplementerTaskPrompt({
    issueNumber: 47,
    taskBrief: "Implement the spawn primitive.\n- bullets\n- here",
    branch: "slice/b6",
  });
  check("task prompt has issue number", tp.includes("#47"));
  check("task prompt has branch", tp.includes("slice/b6"));
  check("task prompt preserves brief verbatim", tp.includes("- bullets"));
}

// --- parseResultDoc ---
{
  const good: ImplementResultDoc = {
    branch: "slice/x",
    commitSha: "abc123",
    verifyResult: { ok: true, output: "all green", exitCode: 0 },
  };
  const parsed = parseResultDoc(JSON.stringify(good));
  check(
    "parses a well-formed result",
    parsed?.branch === "slice/x" &&
      parsed?.commitSha === "abc123" &&
      parsed?.verifyResult.ok === true &&
      parsed?.verifyResult.exitCode === 0,
  );

  check("rejects non-json", parseResultDoc("not json") === undefined);
  check("rejects null", parseResultDoc("null") === undefined);
  check("rejects array", parseResultDoc("[1,2,3]") === undefined);
  check(
    "rejects missing branch",
    parseResultDoc(JSON.stringify({ commitSha: "x", verifyResult: good.verifyResult })) ===
      undefined,
  );
  check(
    "rejects non-string branch",
    parseResultDoc(JSON.stringify({ ...good, branch: 7 })) === undefined,
  );
  check(
    "rejects missing verifyResult",
    parseResultDoc(JSON.stringify({ branch: "x", commitSha: "y" })) === undefined,
  );
  check(
    "rejects verifyResult.ok not bool",
    parseResultDoc(
      JSON.stringify({ ...good, verifyResult: { ...good.verifyResult, ok: "yes" } }),
    ) === undefined,
  );
  check(
    "rejects verifyResult.exitCode not number",
    parseResultDoc(
      JSON.stringify({ ...good, verifyResult: { ...good.verifyResult, exitCode: "0" } }),
    ) === undefined,
  );
  // commitSha may legitimately be empty (no commit made)
  const noCommit = parseResultDoc(JSON.stringify({ ...good, commitSha: "" }));
  check("accepts empty commitSha", noCommit?.commitSha === "");
}

// --- tail ---
{
  check("short string passes through", tail("hello", 10) === "hello");
  const long = "x".repeat(100);
  const t = tail(long, 50);
  check("long string truncated to cap", t.length > 50 && t.endsWith("x".repeat(50)));
  check("long string marker mentions char count", t.includes("truncated 50 chars"));
}

// --- currentSpawnDepth ---
{
  check("no env → depth 0", currentSpawnDepth({}) === 0);
  check("explicit 0 → 0", currentSpawnDepth({ [SPAWN_DEPTH_ENV]: "0" }) === 0);
  check("1 → 1", currentSpawnDepth({ [SPAWN_DEPTH_ENV]: "1" }) === 1);
  check("garbage → 0", currentSpawnDepth({ [SPAWN_DEPTH_ENV]: "wat" }) === 0);
  check("negative → 0", currentSpawnDepth({ [SPAWN_DEPTH_ENV]: "-3" }) === 0);
}

// --- implementSpawn happy path ---
{
  const captured: { opts?: SpawnPiOptions } = {};
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  let readPath: string | undefined;
  let cleanupCalled = false;

  const result = await implementSpawn({
    issueNumber: 47,
    taskBrief: "do it",
    branch: "slice/b6",
    verifyGate: "echo ok",
    cwd: "/repo",
    currentDepth: 0,
    spawnImpl: async (opts) => {
      captured.opts = opts;
      return {
        exitCode: 0,
        wasAborted: false,
        assistantText: "I wrote the file and exited.",
        assistantTurns: 3,
        stderr: "",
        invocation: { command: "pi", args: [] },
      };
    },
    mkResultDir: () => dir,
    readResultFile: (p) => {
      readPath = p;
      return JSON.stringify({
        branch: "slice/b6",
        commitSha: "deadbeef",
        verifyResult: { ok: true, output: "all green", exitCode: 0 },
      });
    },
    cleanup: () => {
      cleanupCalled = true;
    },
  });

  check("happy: outcome=ok", result.outcome === "ok");
  check("happy: result populated", result.result?.commitSha === "deadbeef");
  check("happy: exit 0", result.exitCode === 0);
  check("happy: not aborted", result.wasAborted === false);
  check("happy: cleanup called", cleanupCalled);
  check(
    "happy: reads from temp dir result.json",
    readPath === join(dir, "result.json"),
    `readPath: ${readPath}`,
  );

  // env passed to spawn
  const env = captured.opts!.env!;
  check(
    "spawn env bumps depth from 0 → 1",
    env[SPAWN_DEPTH_ENV] === "1",
  );
  check(
    "spawn env carries result file path",
    env[RESULT_FILE_ENV] === join(dir, "result.json"),
  );
  check("spawn cwd propagated", captured.opts!.cwd === "/repo");
  check("spawn system-prompt file passed", captured.opts!.systemPromptFile === join(dir, "system-prompt.md"));
  check(
    "spawn task contains issue number",
    captured.opts!.task.includes("#47"),
  );

  rmSync(dir, { recursive: true, force: true });
}

// --- depth bump from N ---
{
  const captured: { opts?: SpawnPiOptions } = {};
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  await implementSpawn({
    issueNumber: 1,
    taskBrief: "x",
    branch: "b",
    verifyGate: "v",
    cwd: ".",
    currentDepth: 2, // we're 2 deep already
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
    readResultFile: () =>
      JSON.stringify({
        branch: "b",
        commitSha: "x",
        verifyResult: { ok: true, output: "", exitCode: 0 },
      }),
    cleanup: () => {},
  });
  check(
    "depth bump from 2 → 3",
    captured.opts!.env![SPAWN_DEPTH_ENV] === "3",
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- no result file ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const result = await implementSpawn({
    issueNumber: 1,
    taskBrief: "x",
    branch: "b",
    verifyGate: "v",
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 0,
      wasAborted: false,
      assistantText: "done",
      assistantTurns: 1,
      stderr: "",
      invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("no result file → outcome=no_result_file", result.outcome === "no_result_file");
  check("no result file → reason mentions path", !!result.reason && result.reason.includes("result.json"));
  rmSync(dir, { recursive: true, force: true });
}

// --- malformed result file ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const result = await implementSpawn({
    issueNumber: 1,
    taskBrief: "x",
    branch: "b",
    verifyGate: "v",
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 0,
      wasAborted: false,
      assistantText: "I wrote garbage",
      assistantTurns: 1,
      stderr: "",
      invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => "{ not json",
    cleanup: () => {},
  });
  check("garbage result file → outcome=bad_result_file", result.outcome === "bad_result_file");
  check("garbage result → reason includes raw prefix", !!result.reason && result.reason.includes("{ not json"));
  rmSync(dir, { recursive: true, force: true });
}

// --- subprocess non-zero exit ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const result = await implementSpawn({
    issueNumber: 1,
    taskBrief: "x",
    branch: "b",
    verifyGate: "v",
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 17,
      wasAborted: false,
      assistantText: "crashed",
      assistantTurns: 1,
      stderr: "boom",
      invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("exit 17 → outcome=spawn_failed", result.outcome === "spawn_failed");
  check("exit 17 → exitCode preserved", result.exitCode === 17);
  check("spawn_failed → stderr captured", result.stderrTail === "boom");
  rmSync(dir, { recursive: true, force: true });
}

// --- aborted ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  const result = await implementSpawn({
    issueNumber: 1,
    taskBrief: "x",
    branch: "b",
    verifyGate: "v",
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async () => ({
      exitCode: 143,
      wasAborted: true,
      assistantText: "",
      assistantTurns: 0,
      stderr: "",
      invocation: { command: "pi", args: [] },
    }),
    mkResultDir: () => dir,
    readResultFile: () => undefined,
    cleanup: () => {},
  });
  check("aborted → outcome=aborted", result.outcome === "aborted");
  check("aborted → wasAborted=true", result.wasAborted === true);
  rmSync(dir, { recursive: true, force: true });
}

// --- cleanup runs even on spawn throw ---
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
  let cleanupCalled = false;
  let threw: Error | undefined;
  try {
    await implementSpawn({
      issueNumber: 1,
      taskBrief: "x",
      branch: "b",
      verifyGate: "v",
      cwd: ".",
      currentDepth: 0,
      spawnImpl: async () => {
        throw new Error("spawn blew up");
      },
      mkResultDir: () => dir,
      readResultFile: () => undefined,
      cleanup: () => {
        cleanupCalled = true;
      },
    });
  } catch (err) {
    threw = err as Error;
  }
  check("spawn throw propagates", threw?.message === "spawn blew up");
  check("cleanup still ran via finally", cleanupCalled);
  rmSync(dir, { recursive: true, force: true });
}

// --- system prompt actually written to disk (real fs path through real mkResultDir) ---
{
  let observedSpFile: string | undefined;
  const result = await implementSpawn({
    issueNumber: 99,
    taskBrief: "smoke",
    branch: "slice/smoke",
    verifyGate: "true",
    cwd: ".",
    currentDepth: 0,
    spawnImpl: async (opts) => {
      observedSpFile = opts.systemPromptFile;
      // verify the file actually exists and has the expected content
      const content = await import("node:fs").then((m) =>
        m.readFileSync(opts.systemPromptFile!, "utf8"),
      );
      check("system prompt file exists on disk", content.includes("PI_FLOW_RESULT_FILE"));
      check("system prompt file content includes branch", content.includes("slice/smoke"));
      return {
        exitCode: 0,
        wasAborted: false,
        assistantText: "ok",
        assistantTurns: 1,
        stderr: "",
        invocation: { command: "pi", args: [] },
      };
    },
    readResultFile: () =>
      JSON.stringify({
        branch: "slice/smoke",
        commitSha: "x",
        verifyResult: { ok: true, output: "", exitCode: 0 },
      }),
    // use real mkResultDir + real cleanup so we test the default DI fallbacks too
  });
  check("real-fs path returns ok", result.outcome === "ok");
  check("real-fs system-prompt file path was passed", !!observedSpFile);
}

// --- tail respects default cap ---
{
  const big = "y".repeat(TAIL_CAP + 500);
  const t = tail(big);
  check("default cap applied", t.includes(`truncated 500 chars`));
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
