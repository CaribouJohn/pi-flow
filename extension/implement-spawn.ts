/**
 * implement-spawn — the B6 implementer sub-agent primitive.
 *
 * Layers above `spawn-pi`:
 *   1. Compose a "implement this slice on this branch" task prompt
 *      from the issue context + verify-gate command.
 *   2. Establish the **result-file contract**: the child receives a
 *      writable path via `PI_FLOW_RESULT_FILE` and is instructed (via
 *      `--append-system-prompt`) to write a JSON result document to
 *      it before exiting. The parent reads the file after close.
 *   3. Enforce the **recursion guard**: callers (the tool wrapper in
 *      index.ts) check `PI_FLOW_SPAWN_DEPTH > 0` and refuse; we set
 *      `PI_FLOW_SPAWN_DEPTH=<n+1>` when spawning so the child sees it.
 *   4. Parse the result file (or surface a structured failure if the
 *      child crashed / never wrote it / wrote garbage).
 *
 * The result file is the load-bearing contract — not the child's
 * final assistant text — because text parsing is prompt-fragile and
 * the json-mode stream's "final message" is whatever the model said
 * last, which may or may not be a fenced JSON block.
 *
 * The contract this module defines IS the API B8 (loop body) will
 * call. Keep the shape stable.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPi, type SpawnPiOptions, type SpawnPiResult } from "./spawn-pi.ts";

// --- public types ---------------------------------------------------

export type VerifyResult = {
  /** True if the verify gate exited 0. */
  ok: boolean;
  /** Verbatim stdout+stderr (capped — see DEFAULT_OUTPUT_CAP). */
  output: string;
  /** Exit code of the verify-gate command. */
  exitCode: number;
};

/**
 * The JSON document the implementer is required to write to the
 * result file. Mirrors DESIGN.md §Architecture line 40.
 */
export type ImplementResultDoc = {
  branch: string;
  commitSha: string;
  verifyResult: VerifyResult;
};

/**
 * What the orchestrator receives. A superset of the doc — adds
 * outcome metadata about the spawn itself.
 */
export type ImplementSpawnResult = {
  /** "ok" → child completed AND wrote a valid result file. */
  outcome: "ok" | "spawn_failed" | "no_result_file" | "bad_result_file" | "aborted";
  /** Present iff outcome === "ok". */
  result?: ImplementResultDoc;
  /** Exit code of the implementer subprocess. */
  exitCode: number;
  /** Was the run aborted via the caller's AbortSignal. */
  wasAborted: boolean;
  /** Tail of the implementer's final assistant text (for diagnostics). */
  assistantTail: string;
  /** Tail of implementer's stderr (for diagnostics). */
  stderrTail: string;
  /** Human-readable explanation when outcome !== "ok". */
  reason?: string;
};

export type ImplementSpawnOptions = {
  /** Issue number to implement (e.g., 47). */
  issueNumber: number;
  /** Brief: title + body + key acceptance bullets the implementer needs. */
  taskBrief: string;
  /** Branch the implementer must commit to (orchestrator creates it). */
  branch: string;
  /** Verify-gate shell command (from profile.verify_gate). */
  verifyGate: string;
  /** Working directory for the spawned `pi`. */
  cwd: string;
  /** Optional model override (default: child uses its own default). */
  model?: string;
  /** Current spawn depth (caller increments before passing). 0 at the top. */
  currentDepth: number;
  /** Optional AbortSignal. */
  signal?: AbortSignal;

  // --- DI seams for testing ---
  /** Inject spawn for testing. Real path uses spawnPi. */
  spawnImpl?: (opts: SpawnPiOptions) => Promise<SpawnPiResult>;
  /** Inject the temp-dir creation. */
  mkResultDir?: () => string;
  /** Inject the file reader (called once after subprocess close). */
  readResultFile?: (path: string) => string | undefined;
  /** Inject cleanup. */
  cleanup?: (dir: string) => void;
};

// --- constants ------------------------------------------------------

/** Truncate captured assistant text / stderr to this many chars in the result. */
export const TAIL_CAP = 2000;

/** Env var the recursion guard pivots on. */
export const SPAWN_DEPTH_ENV = "PI_FLOW_SPAWN_DEPTH";

/** Env var that hands the child a writable result-file path. */
export const RESULT_FILE_ENV = "PI_FLOW_RESULT_FILE";

// --- pure helpers (covered by smoke) --------------------------------

/**
 * Render the system-prompt fragment that teaches the implementer the
 * result-file contract. Appended to whatever default system prompt
 * the spawned `pi` already carries.
 *
 * Kept terse — the implementer has its own coding-assistant system
 * prompt and skills; we only need to add the **result protocol**.
 */
export function buildImplementerSystemPrompt(opts: {
  branch: string;
  verifyGate: string;
}): string {
  return [
    "# pi-flow implementer protocol",
    "",
    "You were spawned by the pi-flow orchestrator to implement a single",
    "slice. When you finish (whether the work succeeded or not), you MUST",
    "write a JSON document to the path in `$PI_FLOW_RESULT_FILE` and exit.",
    "",
    "## Required document shape",
    "",
    "```json",
    '{ "branch": "<git branch you committed to>",',
    '  "commitSha": "<HEAD sha after your final commit, or \\"\\" if none>",',
    '  "verifyResult": { "ok": <bool>, "output": "<verify gate output>", "exitCode": <int> } }',
    "```",
    "",
    `Branch you are working on: \`${opts.branch}\``,
    `Verify gate to run before reporting: \`${opts.verifyGate}\``,
    "",
    "## Hard rules",
    "",
    "- DO NOT spawn other pi-flow sub-agents (no `flow_implement_spawn`,",
    "  no `flow_review_spawn`). The recursion guard will reject you.",
    "- DO NOT switch branches; commit to the branch named above.",
    '- ALWAYS write the result file before your last turn, even on failure',
    "  (set `verifyResult.ok = false` and explain in `verifyResult.output`).",
    "- Do not push or open a PR — the orchestrator does that.",
  ].join("\n");
}

/**
 * Render the task prompt (positional final arg to `pi`). Frame: what
 * the implementer needs to know about the slice itself.
 */
export function buildImplementerTaskPrompt(opts: {
  issueNumber: number;
  taskBrief: string;
  branch: string;
}): string {
  return [
    `Task: implement issue #${opts.issueNumber} on branch \`${opts.branch}\`.`,
    "",
    "## Slice brief",
    "",
    opts.taskBrief,
    "",
    "## Done means",
    "",
    "- Code committed to the branch.",
    "- Verify gate run; result captured.",
    "- Result file written per the implementer protocol in your system prompt.",
  ].join("\n");
}

/**
 * Parse the result file's contents. Returns undefined on malformed
 * input rather than throwing — the caller wraps undefined in a
 * structured `outcome` value.
 */
export function parseResultDoc(raw: string): ImplementResultDoc | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;
  if (typeof p.branch !== "string") return undefined;
  if (typeof p.commitSha !== "string") return undefined;
  const v = p.verifyResult as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.ok !== "boolean") return undefined;
  if (typeof v.output !== "string") return undefined;
  if (typeof v.exitCode !== "number") return undefined;
  return {
    branch: p.branch,
    commitSha: p.commitSha,
    verifyResult: {
      ok: v.ok,
      output: v.output,
      exitCode: v.exitCode,
    },
  };
}

/** Truncate a string to `cap` chars, prefixing "...truncated..." marker if it bit. */
export function tail(s: string, cap: number = TAIL_CAP): string {
  if (s.length <= cap) return s;
  return `…(truncated ${s.length - cap} chars)…${s.slice(-cap)}`;
}

// --- the recursion-guard predicate ---------------------------------

/**
 * Caller-side guard. Returns the current depth as a number; the tool
 * wrapper in index.ts should refuse if this is > 0.
 */
export function currentSpawnDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SPAWN_DEPTH_ENV];
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// --- main entry point ----------------------------------------------

export async function implementSpawn(
  opts: ImplementSpawnOptions,
): Promise<ImplementSpawnResult> {
  const spawnImpl = opts.spawnImpl ?? spawnPi;
  const mkResultDir =
    opts.mkResultDir ?? (() => mkdtempSync(join(tmpdir(), "pi-flow-implement-")));
  const readResultFile =
    opts.readResultFile ??
    ((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });
  const cleanup =
    opts.cleanup ??
    ((dir) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

  const dir = mkResultDir();
  const resultFile = join(dir, "result.json");
  const systemPromptFile = join(dir, "system-prompt.md");

  const systemPrompt = buildImplementerSystemPrompt({
    branch: opts.branch,
    verifyGate: opts.verifyGate,
  });
  const task = buildImplementerTaskPrompt({
    issueNumber: opts.issueNumber,
    taskBrief: opts.taskBrief,
    branch: opts.branch,
  });

  try {
    writeFileSync(systemPromptFile, systemPrompt, { mode: 0o600 });

    const spawnResult = await spawnImpl({
      cwd: opts.cwd,
      task,
      systemPromptFile,
      model: opts.model,
      env: {
        [SPAWN_DEPTH_ENV]: String(opts.currentDepth + 1),
        [RESULT_FILE_ENV]: resultFile,
      },
      signal: opts.signal,
    });

    const assistantTail = tail(spawnResult.assistantText);
    const stderrTail = tail(spawnResult.stderr);

    if (spawnResult.wasAborted) {
      return {
        outcome: "aborted",
        exitCode: spawnResult.exitCode,
        wasAborted: true,
        assistantTail,
        stderrTail,
        reason: "Implementer subprocess was aborted before completion.",
      };
    }

    if (spawnResult.exitCode !== 0) {
      // The child may still have written a partial result before crashing.
      // Try to read it for diagnostics, but report spawn_failed.
      const maybeRaw = readResultFile(resultFile);
      return {
        outcome: "spawn_failed",
        exitCode: spawnResult.exitCode,
        wasAborted: false,
        assistantTail,
        stderrTail,
        reason: `Implementer exited with code ${spawnResult.exitCode}.${
          maybeRaw ? " A (possibly partial) result file was found." : ""
        }`,
      };
    }

    const raw = readResultFile(resultFile);
    if (raw === undefined) {
      return {
        outcome: "no_result_file",
        exitCode: 0,
        wasAborted: false,
        assistantTail,
        stderrTail,
        reason: `Implementer exited cleanly but never wrote to ${resultFile}.`,
      };
    }

    const doc = parseResultDoc(raw);
    if (!doc) {
      return {
        outcome: "bad_result_file",
        exitCode: 0,
        wasAborted: false,
        assistantTail,
        stderrTail,
        reason: `Implementer wrote a result file but it did not match the required shape. First 500 chars: ${raw.slice(0, 500)}`,
      };
    }

    return {
      outcome: "ok",
      result: doc,
      exitCode: 0,
      wasAborted: false,
      assistantTail,
      stderrTail,
    };
  } finally {
    cleanup(dir);
  }
}
