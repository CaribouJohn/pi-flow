/**
 * Smoke for the B2 poller. Run with:
 *   bun extension/poller.smoke.ts
 *
 * Stubs the `run` dep with canned `gh issue list` / `gh pr list` JSON.
 * Covers: initial snapshot has no diffs; label-added; label-removed;
 * opened; closed; pr-merged-closes; non-flow-issue resilience; clock
 * injection via `now`.
 */

import { flowPoll, type PollDeps, type Snapshot } from "./poller.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

/** Build a `run` stub that returns canned JSON keyed by the first
 *  positional after `issue`/`pr`. Throws if asked for an unrecognised
 *  shape. */
function makeRun(issues: unknown[], prs: unknown[]) {
  return async (args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") {
      return {
        stdout: JSON.stringify(issues),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return {
        stdout: JSON.stringify(prs),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
}

const labels = ["ready-for-agent", "needs-acceptance", "review:human"];

// --- initial snapshot has no diffs ---
{
  const deps: PollDeps = {
    run: makeRun([], []),
    now: () => 1000,
  };
  const { snapshot, diffs } = await flowPoll(null, deps, { labels });
  check("initial snapshot empty issues", snapshot.issues.size === 0);
  check("initial snapshot empty prs", snapshot.prs.size === 0);
  check("initial snapshot ts === 1000", snapshot.ts === 1000);
  check("initial snapshot has no diffs", diffs.length === 0);
}

// --- label-added ---
{
  const prev: Snapshot = {
    issues: new Map([
      [
        10,
        {
          number: 10,
          state: "OPEN",
          labels: ["needs-triage"],
          assignees: [],
          updatedAt: "2026-06-12T00:00:00Z",
        },
      ],
    ]),
    prs: new Map(),
    ts: 999,
  };
  const deps: PollDeps = {
    run: makeRun(
      [
        {
          number: 10,
          state: "OPEN",
          labels: [{ name: "needs-triage" }, { name: "ready-for-agent" }],
          assignees: [],
          updatedAt: "2026-06-12T00:01:00Z",
        },
      ],
      [],
    ),
    now: () => 2000,
  };
  const { diffs } = await flowPoll(prev, deps, { labels });
  check(
    "label-added detected",
    diffs.length === 1 &&
      diffs[0].kind === "label-added" &&
      diffs[0].issue === 10 &&
      diffs[0].label === "ready-for-agent",
  );
}

// --- label-removed ---
{
  const prev: Snapshot = {
    issues: new Map([
      [
        10,
        {
          number: 10,
          state: "OPEN",
          labels: ["needs-triage", "review:human"],
          assignees: [],
          updatedAt: "2026-06-12T00:00:00Z",
        },
      ],
    ]),
    prs: new Map(),
    ts: 999,
  };
  const deps: PollDeps = {
    run: makeRun(
      [
        {
          number: 10,
          state: "OPEN",
          labels: [{ name: "needs-triage" }],
          assignees: [],
          updatedAt: "2026-06-12T00:01:00Z",
        },
      ],
      [],
    ),
    now: () => 2000,
  };
  const { diffs } = await flowPoll(prev, deps, { labels });
  check(
    "label-removed detected",
    diffs.length === 1 &&
      diffs[0].kind === "label-removed" &&
      diffs[0].label === "review:human",
  );
}

// --- opened (newly-appearing OPEN issue) ---
{
  const prev: Snapshot = { issues: new Map(), prs: new Map(), ts: 999 };
  const deps: PollDeps = {
    run: makeRun(
      [
        {
          number: 20,
          state: "OPEN",
          labels: [{ name: "needs-triage" }],
          assignees: [],
          updatedAt: "2026-06-12T00:00:00Z",
        },
      ],
      [],
    ),
    now: () => 2000,
  };
  const { diffs } = await flowPoll(prev, deps, { labels });
  check(
    "opened detected for newly-appearing OPEN issue",
    diffs.length === 1 && diffs[0].kind === "opened" && diffs[0].issue === 20,
  );
}

// --- closed transition ---
{
  const prev: Snapshot = {
    issues: new Map([
      [
        30,
        {
          number: 30,
          state: "OPEN",
          labels: ["ready-for-agent"],
          assignees: [],
          updatedAt: "2026-06-12T00:00:00Z",
        },
      ],
    ]),
    prs: new Map(),
    ts: 999,
  };
  const deps: PollDeps = {
    run: makeRun(
      [
        {
          number: 30,
          state: "CLOSED",
          labels: [{ name: "ready-for-agent" }],
          assignees: [],
          updatedAt: "2026-06-12T00:01:00Z",
        },
      ],
      [],
    ),
    now: () => 2000,
  };
  const { diffs } = await flowPoll(prev, deps, { labels });
  check(
    "closed transition detected",
    diffs.some((d) => d.kind === "closed" && d.issue === 30),
  );
}

// --- pr-merged-closes ---
{
  const prev: Snapshot = {
    issues: new Map(),
    prs: new Map([
      [
        100,
        {
          number: 100,
          state: "OPEN",
          closingIssues: [40, 41],
        },
      ],
    ]),
    ts: 999,
  };
  const deps: PollDeps = {
    run: makeRun(
      [],
      [
        {
          number: 100,
          state: "MERGED",
          closingIssuesReferences: [{ number: 40 }, { number: 41 }],
        },
      ],
    ),
    now: () => 2000,
  };
  const { diffs } = await flowPoll(prev, deps, { labels });
  const merges = diffs.filter((d) => d.kind === "pr-merged-closes");
  check("pr-merged-closes fires once per closed issue", merges.length === 2);
  check(
    "pr-merged-closes carries pr + issue numbers",
    merges.every(
      (d) =>
        d.kind === "pr-merged-closes" &&
        d.pr === 100 &&
        (d.issue === 40 || d.issue === 41),
    ),
  );
}

// --- non-flow-issue resilience: extra fields in raw JSON don't crash ---
{
  const prev: Snapshot = { issues: new Map(), prs: new Map(), ts: 999 };
  const deps: PollDeps = {
    run: makeRun(
      [
        {
          number: 50,
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "bot" }],
          updatedAt: "2026-06-12T00:00:00Z",
          // Extra field gh might return if we ask for more in the future:
          author: { login: "someone" },
        },
      ],
      [],
    ),
    now: () => 2000,
  };
  const { snapshot, diffs } = await flowPoll(prev, deps, { labels });
  check(
    "extra raw fields do not crash; assignees captured",
    snapshot.issues.get(50)?.assignees[0] === "bot" &&
      diffs.some((d) => d.kind === "opened"),
  );
}

// --- gh error surfaces ---
{
  const deps: PollDeps = {
    run: async () => ({ stdout: "", stderr: "auth required", code: 4 }),
    now: () => 2000,
  };
  let threw = false;
  try {
    await flowPoll(null, deps, { labels });
  } catch (err) {
    threw = err instanceof Error && err.message.includes("exited 4");
  }
  check("gh non-zero surfaces as Error", threw);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
