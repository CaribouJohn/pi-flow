/**
 * review-spawn — the B7 reviewer sub-agent primitive.
 *
 * Mirror of `implement-spawn.ts`. Layers above the generic `spawn-pi`
 * helper:
 *   1. Compose a "review this slice" task prompt from the issue number
 *      + slice branch (and optional PR number).
 *   2. Same **result-file contract** as B6: child writes a JSON document
 *      to `PI_FLOW_RESULT_FILE` before exit. Strict shape validation.
 *   3. Same **recursion guard** as B6 — we import `currentSpawnDepth` /
 *      `SPAWN_DEPTH_ENV` / `RESULT_FILE_ENV` / `tail` / `TAIL_CAP` from
 *      `implement-spawn` rather than duplicating.
 *
 * Result document (per DESIGN.md §Architecture line 56-59):
 *   { verdict: "approve" | "changes-requested" | "escalate",
 *     comments: string[] }
 *
 * Diff-fetching strategy: **Option B** — the reviewer fetches the diff
 * itself via `gh pr diff $N` or `git diff` (bash access is given to the
 * sub-session by default). The system prompt instructs it how. This
 * avoids embedding potentially-huge diffs in the task prompt and matches
 * how a human reviewer works (open the PR, drill into suspicious files).
 *
 * What B7 explicitly does NOT do (deferred to B8):
 *   - Posting comments back to the PR/issue.
 *   - Iteration counting against `profile.reviewer_iteration_cap`.
 *   - Escalation labelling (`review:human`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPi, type SpawnPiOptions, type SpawnPiResult } from "./spawn-pi.ts";
import {
  SPAWN_DEPTH_ENV,
  RESULT_FILE_ENV,
  tail,
} from "./implement-spawn.ts";

// --- public types ---------------------------------------------------

export const VERDICT_VALUES = ["approve", "changes-requested", "escalate"] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

/** The JSON document the reviewer is required to write to the result file. */
export type ReviewVerdictDoc = {
  verdict: Verdict;
  comments: string[];
};

export type ReviewSpawnResult = {
  /** "ok" → child completed AND wrote a valid verdict file. */
  outcome: "ok" | "spawn_failed" | "no_result_file" | "bad_result_file" | "aborted";
  /** Present iff outcome === "ok". */
  result?: ReviewVerdictDoc;
  exitCode: number;
  wasAborted: boolean;
  assistantTail: string;
  stderrTail: string;
  reason?: string;
};

export type ReviewSpawnOptions = {
  /** Issue number being reviewed (e.g., 48). */
  issueNumber: number;
  /** Slice branch the implementer committed to. */
  sliceBranch: string;
  /** Base branch the slice will merge into (for diff scoping). */
  baseBranch: string;
  /** Optional PR number — if set, the reviewer can use `gh pr diff $N`. */
  prNumber?: number;
  /** Optional context blurb (slice title, acceptance criteria, etc.). */
  sliceBrief?: string;
  /** Working directory for the spawned `pi`. */
  cwd: string;
  /** Optional model override. */
  model?: string;
  /** Current spawn depth (caller increments before passing). 0 at the top. */
  currentDepth: number;
  /** Reviewer command label from profile (used in prompt for role framing only). */
  reviewerCommand?: string;
  /** Optional AbortSignal. */
  signal?: AbortSignal;

  // --- DI seams for testing ---
  spawnImpl?: (opts: SpawnPiOptions) => Promise<SpawnPiResult>;
  mkResultDir?: () => string;
  readResultFile?: (path: string) => string | undefined;
  cleanup?: (dir: string) => void;
};

// --- pure helpers (covered by smoke) --------------------------------

/**
 * Render the system-prompt fragment that teaches the reviewer the
 * result-file contract and how to fetch the diff itself.
 */
export function buildReviewerSystemPrompt(opts: {
  sliceBranch: string;
  baseBranch: string;
  prNumber?: number;
  reviewerCommand?: string;
}): string {
  const diffHints: string[] = [];
  if (opts.prNumber != null) {
    diffHints.push(`- \`gh pr diff ${opts.prNumber}\` — full unified diff of the PR.`);
    diffHints.push(`- \`gh pr view ${opts.prNumber} --json files\` — list of changed files.`);
  }
  diffHints.push(
    `- \`git diff ${opts.baseBranch}...${opts.sliceBranch}\` — diff vs. base, three-dot.`,
    `- \`git log ${opts.baseBranch}..${opts.sliceBranch}\` — commits on the slice.`,
    "- Read individual files at the slice head once you've identified what changed.",
  );

  return [
    "# pi-flow reviewer protocol",
    "",
    `You were spawned by the pi-flow orchestrator as a code reviewer${
      opts.reviewerCommand ? ` (role: \`${opts.reviewerCommand}\`)` : ""
    }. You are reviewing a single slice branch. When you finish, you MUST`,
    "write a JSON verdict document to the path in `$PI_FLOW_RESULT_FILE` and exit.",
    "",
    "## Required document shape",
    "",
    "```json",
    '{ "verdict": "approve" | "changes-requested" | "escalate",',
    '  "comments": ["<line-or-paragraph>", "..."] }',
    "```",
    "",
    "Verdict semantics:",
    '- `approve` — the slice meets its acceptance criteria; ship it.',
    '- `changes-requested` — concrete, actionable issues exist; list them in `comments` so the implementer can fix and re-submit.',
    '- `escalate` — out-of-scope concerns, architectural surprises, or anything a human should see before continuing.',
    "",
    `## The slice under review`,
    "",
    `- Slice branch: \`${opts.sliceBranch}\``,
    `- Base branch:  \`${opts.baseBranch}\``,
    opts.prNumber != null ? `- PR number:    #${opts.prNumber}` : "- PR number:    (none — pre-PR review)",
    "",
    "## Fetching the diff yourself",
    "",
    "Use bash to read what actually changed (do NOT wait for the diff to be handed to you):",
    "",
    ...diffHints,
    "",
    "## Hard rules",
    "",
    "- DO NOT spawn other pi-flow sub-agents (no `flow_implement_spawn`,",
    "  no `flow_review_spawn`). The recursion guard will reject you.",
    "- DO NOT push commits, open PRs, or post PR comments yourself —",
    "  the orchestrator posts your verdict's `comments` back to the PR.",
    "- DO NOT modify any files. You are read-only.",
    "- ALWAYS write the result file before your last turn, even if you",
    "  cannot complete the review (use `escalate` with a comment explaining why).",
  ].join("\n");
}

/**
 * Render the task prompt (positional final arg to `pi`).
 */
export function buildReviewerTaskPrompt(opts: {
  issueNumber: number;
  sliceBranch: string;
  sliceBrief?: string;
}): string {
  const lines: string[] = [
    `Task: review the slice for issue #${opts.issueNumber} on branch \`${opts.sliceBranch}\`.`,
  ];
  if (opts.sliceBrief && opts.sliceBrief.trim().length > 0) {
    lines.push("", "## Slice brief (acceptance criteria, intent)", "", opts.sliceBrief);
  }
  lines.push(
    "",
    "## Done means",
    "",
    "- You have read the diff and the relevant files.",
    "- You have written a `{verdict, comments}` document to `$PI_FLOW_RESULT_FILE`.",
    "- You have exited.",
  );
  return lines.join("\n");
}

/**
 * Parse the verdict file's contents. Returns undefined on malformed input.
 */
export function parseVerdictDoc(raw: string): ReviewVerdictDoc | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const p = parsed as Record<string, unknown>;
  if (typeof p.verdict !== "string") return undefined;
  if (!(VERDICT_VALUES as readonly string[]).includes(p.verdict)) return undefined;
  if (!Array.isArray(p.comments)) return undefined;
  if (!p.comments.every((c) => typeof c === "string")) return undefined;
  return {
    verdict: p.verdict as Verdict,
    comments: p.comments as string[],
  };
}

// --- main entry point ----------------------------------------------

export async function reviewSpawn(
  opts: ReviewSpawnOptions,
): Promise<ReviewSpawnResult> {
  const spawnImpl = opts.spawnImpl ?? spawnPi;
  const mkResultDir =
    opts.mkResultDir ?? (() => mkdtempSync(join(tmpdir(), "pi-flow-review-")));
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
  const resultFile = join(dir, "verdict.json");
  const systemPromptFile = join(dir, "system-prompt.md");

  const systemPrompt = buildReviewerSystemPrompt({
    sliceBranch: opts.sliceBranch,
    baseBranch: opts.baseBranch,
    prNumber: opts.prNumber,
    reviewerCommand: opts.reviewerCommand,
  });
  const task = buildReviewerTaskPrompt({
    issueNumber: opts.issueNumber,
    sliceBranch: opts.sliceBranch,
    sliceBrief: opts.sliceBrief,
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
        reason: "Reviewer subprocess was aborted before completion.",
      };
    }

    if (spawnResult.exitCode !== 0) {
      const maybeRaw = readResultFile(resultFile);
      return {
        outcome: "spawn_failed",
        exitCode: spawnResult.exitCode,
        wasAborted: false,
        assistantTail,
        stderrTail,
        reason: `Reviewer exited with code ${spawnResult.exitCode}.${
          maybeRaw ? " A (possibly partial) verdict file was found." : ""
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
        reason: `Reviewer exited cleanly but never wrote to ${resultFile}.`,
      };
    }

    const doc = parseVerdictDoc(raw);
    if (!doc) {
      return {
        outcome: "bad_result_file",
        exitCode: 0,
        wasAborted: false,
        assistantTail,
        stderrTail,
        reason: `Reviewer wrote a verdict file but it did not match the required shape. First 500 chars: ${raw.slice(0, 500)}`,
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
