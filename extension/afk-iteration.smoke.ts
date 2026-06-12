/**
 * Smoke for afk-iteration. Run with:
 *   bun extension/afk-iteration.smoke.ts
 */

import {
  AFK_ITERATION_ENTRY_TYPE,
  bumpIteration,
  loadIterationFromMap,
  replayIterations,
  resetIteration,
  type ReplayEntry,
} from "./afk-iteration.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

function makeEntry(data: unknown): ReplayEntry {
  return { type: "custom", customType: AFK_ITERATION_ENTRY_TYPE, data };
}
function otherEntry(): ReplayEntry {
  return { type: "custom", customType: "some-other-type", data: { kind: "bump", issueNumber: 99, ts: 0 } };
}
function nonCustomEntry(): ReplayEntry {
  return { type: "session_start", data: { kind: "bump", issueNumber: 99, ts: 0 } };
}

// ====================================================================
// replayIterations — pure reducer
// ====================================================================

// empty
{
  const m = replayIterations([]);
  check("replay empty → empty map", m.size === 0);
}

// single bump
{
  const m = replayIterations([makeEntry({ kind: "bump", issueNumber: 42, ts: 1 })]);
  check("replay single bump → 1", m.get(42) === 1);
  check("replay single bump → no other keys", m.size === 1);
}

// multiple bumps same issue
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 42, ts: 1 }),
    makeEntry({ kind: "bump", issueNumber: 42, ts: 2 }),
    makeEntry({ kind: "bump", issueNumber: 42, ts: 3 }),
  ]);
  check("replay 3 bumps → 3", m.get(42) === 3);
}

// bumps for multiple issues accumulate independently
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 10, ts: 1 }),
    makeEntry({ kind: "bump", issueNumber: 20, ts: 2 }),
    makeEntry({ kind: "bump", issueNumber: 10, ts: 3 }),
  ]);
  check("replay multi-issue: issue 10 → 2", m.get(10) === 2);
  check("replay multi-issue: issue 20 → 1", m.get(20) === 1);
}

// reset clears to 0
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 42, ts: 1 }),
    makeEntry({ kind: "bump", issueNumber: 42, ts: 2 }),
    makeEntry({ kind: "reset", issueNumber: 42, ts: 3 }),
  ]);
  check("replay reset → 0", m.get(42) === 0);
}

// bump after reset accumulates from 0
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 42, ts: 1 }),
    makeEntry({ kind: "bump", issueNumber: 42, ts: 2 }),
    makeEntry({ kind: "reset", issueNumber: 42, ts: 3 }),
    makeEntry({ kind: "bump", issueNumber: 42, ts: 4 }),
  ]);
  check("replay bump-after-reset → 1", m.get(42) === 1);
}

// reset does not touch other issues
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 10, ts: 1 }),
    makeEntry({ kind: "bump", issueNumber: 20, ts: 2 }),
    makeEntry({ kind: "reset", issueNumber: 10, ts: 3 }),
  ]);
  check("reset does not touch other issues", m.get(20) === 1);
  check("reset zeroes only target issue", m.get(10) === 0);
}

// malformed: missing kind → skipped
{
  const m = replayIterations([makeEntry({ issueNumber: 42, ts: 1 })]);
  check("malformed missing kind → skipped", m.size === 0);
}

// malformed: missing issueNumber → skipped
{
  const m = replayIterations([makeEntry({ kind: "bump", ts: 1 })]);
  check("malformed missing issueNumber → skipped", m.size === 0);
}

// malformed: issueNumber wrong type → skipped
{
  const m = replayIterations([makeEntry({ kind: "bump", issueNumber: "42", ts: 1 })]);
  check("malformed issueNumber string → skipped", m.size === 0);
}

// malformed: unknown kind → skipped (no change)
{
  const m = replayIterations([
    makeEntry({ kind: "bump", issueNumber: 42, ts: 1 }),
    makeEntry({ kind: "frobnicate", issueNumber: 42, ts: 2 }),
  ]);
  check("malformed unknown kind → skipped, prior bump preserved", m.get(42) === 1);
}

// malformed: null data → skipped
{
  const m = replayIterations([makeEntry(null)]);
  check("malformed null data → skipped", m.size === 0);
}

// malformed: non-object data → skipped
{
  const m = replayIterations([makeEntry("bump")]);
  check("malformed string data → skipped", m.size === 0);
}

// non-iteration entries ignored
{
  const m = replayIterations([
    otherEntry(),
    nonCustomEntry(),
    makeEntry({ kind: "bump", issueNumber: 7, ts: 1 }),
  ]);
  check("non-iteration entries ignored", m.get(7) === 1 && m.size === 1);
}

// ====================================================================
// loadIterationFromMap
// ====================================================================

{
  const m = new Map([[42, 3]]);
  check("loadIteration returns value from map", loadIterationFromMap(m, 42) === 3);
  check("loadIteration returns 0 for unknown issue", loadIterationFromMap(m, 99) === 0);
}

// ====================================================================
// bumpIteration
// ====================================================================

{
  const appended: { type: string; payload: unknown }[] = [];
  const append = async (type: string, payload: unknown) => { appended.push({ type, payload }); };
  const m = new Map<number, number>();

  const v1 = await bumpIteration(append, m, 42, 100);
  check("bump from 0 → returns 1", v1 === 1);
  check("bump updates map to 1", m.get(42) === 1);
  check("bump appends one entry", appended.length === 1);
  check("bump entry has correct type", appended[0].type === AFK_ITERATION_ENTRY_TYPE);
  const p1 = appended[0].payload as any;
  check("bump payload kind = bump", p1.kind === "bump");
  check("bump payload issueNumber", p1.issueNumber === 42);
  check("bump payload ts", p1.ts === 100);

  const v2 = await bumpIteration(append, m, 42, 200);
  check("second bump → returns 2", v2 === 2);
  check("second bump updates map to 2", m.get(42) === 2);

  // different issue independent
  const v3 = await bumpIteration(append, m, 99, 300);
  check("bump different issue → 1", v3 === 1);
  check("bump different issue does not affect first", m.get(42) === 2);
}

// bumpIteration uses Date.now() when ts omitted
{
  const appended: { payload: unknown }[] = [];
  const append = async (_: string, p: unknown) => { appended.push({ payload: p }); };
  const before = Date.now();
  await bumpIteration(append, new Map(), 1);
  const after = Date.now();
  const ts = (appended[0].payload as any).ts;
  check("bump default ts is close to Date.now()", ts >= before && ts <= after);
}

// ====================================================================
// resetIteration
// ====================================================================

{
  const appended: { type: string; payload: unknown }[] = [];
  const append = async (type: string, payload: unknown) => { appended.push({ type, payload }); };
  const m = new Map([[42, 3], [99, 1]]);

  await resetIteration(append, m, 42, 500);
  check("reset zeroes target in map", m.get(42) === 0);
  check("reset does not touch other issue in map", m.get(99) === 1);
  check("reset appends one entry", appended.length === 1);
  check("reset entry has correct type", appended[0].type === AFK_ITERATION_ENTRY_TYPE);
  const p = appended[0].payload as any;
  check("reset payload kind = reset", p.kind === "reset");
  check("reset payload issueNumber", p.issueNumber === 42);
  check("reset payload ts", p.ts === 500);
}

// resetIteration uses Date.now() when ts omitted
{
  const appended: { payload: unknown }[] = [];
  const append = async (_: string, p: unknown) => { appended.push({ payload: p }); };
  const before = Date.now();
  await resetIteration(append, new Map(), 1);
  const after = Date.now();
  const ts = (appended[0].payload as any).ts;
  check("reset default ts is close to Date.now()", ts >= before && ts <= after);
}

// ====================================================================
// Done
// ====================================================================

if (failed === 0) {
  console.log("\nALL PASS");
  process.exit(0);
} else {
  console.error(`\n${failed} CHECK(S) FAILED`);
  process.exit(1);
}
