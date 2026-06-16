/**
 * Integration test: cost-history writer path === calibrate reader path.
 *
 * Pins the invariant described in brief #163:
 *   "Writer (meter) and reader (calibrate) must resolve the same committed path."
 *
 * Setup: a bare "origin" repo + a workdir clone, mirroring what flowd manages
 * at runtime.  The repo's .gitignore explicitly lists `.flowd/` (the realistic
 * production scenario) so these tests catch the silent-skip bug that plagued
 * plain `git add` (without -f).
 *
 * The commit step uses the real `makeCommitHistoryToTrack` from flow-run.ts
 * rather than a local copy — any drift between the production implementation
 * and these tests is therefore impossible.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readCostRecordsFromGit } from "../src/calibrate.ts";
import { type CostHistoryRecord, appendCostRecord } from "../src/cost-meter.ts";
import { makeCommitHistoryToTrack } from "../src/flow-run.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HISTORY_PATH = ".flowd/cost-history.jsonl";
const TRACK_BRANCH = "track/0001";
const ACTOR = "flowd-bot";

function makeRecord(sliceId: number): CostHistoryRecord {
  return {
    sliceId,
    effort: "medium",
    roles: ["implement", "review"],
    implementModel: "m1",
    reviewModel: "m2",
    totalTokens: 1_200,
    costUSD: 0.045,
    estUSD: 0.04,
    ts: "2026-01-01T00:00:00Z",
  };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

async function initBareOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flowd-origin-"));
  await $`git init --bare ${dir}`.quiet();
  return dir;
}

async function cloneWorkdir(origin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flowd-workdir-"));
  await $`git clone ${origin} ${dir}`.quiet();
  await $`git -C ${dir} config user.email "test@flowd"`.quiet();
  await $`git -C ${dir} config user.name "Test"`.quiet();
  return dir;
}

/**
 * Seed the repo with an initial commit that includes a `.gitignore` excluding
 * `.flowd/` — the realistic project layout.  Without this gitignore the tests
 * would not catch the silent-skip bug triggered by plain `git add` (without -f).
 */
async function bootstrapRepo(workdir: string, trackBranch: string): Promise<void> {
  // .gitignore that mirrors the realistic scenario where .flowd/ is excluded.
  await writeFile(join(workdir, ".gitignore"), ".flowd/\n", "utf8");
  await $`git -C ${workdir} add .gitignore`.quiet();
  await $`git -C ${workdir} commit -m "initial"`.quiet();
  await $`git -C ${workdir} push origin HEAD:main`.quiet();
  // Create and push the track branch.
  await $`git -C ${workdir} checkout -b ${trackBranch}`.quiet();
  await $`git -C ${workdir} push -u origin ${trackBranch}`.quiet();
}

// ── Tests: writer ↔ reader round-trip ─────────────────────────────────────────

describe("cost-history path agreement: writer path === calibrate reader path", () => {
  let workdir: string;
  let bareOrigin: string;

  beforeEach(async () => {
    bareOrigin = await initBareOrigin();
    workdir = await cloneWorkdir(bareOrigin);
    await bootstrapRepo(workdir, TRACK_BRANCH);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(bareOrigin, { recursive: true, force: true });
  });

  test("record appended by meter is readable by calibrate via committed track branch", async () => {
    const rec = makeRecord(42);
    const absPath = join(workdir, HISTORY_PATH);

    // Writer: append the record (meter's write path).
    const appended = await appendCostRecord(absPath, rec);
    expect(appended).toBe(true);

    // Commit to origin/track — use the REAL makeCommitHistoryToTrack so this
    // test validates the production code, not a duplicate local copy.
    const commit = makeCommitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH, ACTOR);
    await commit();

    // Reader: calibrate reads via git show origin/<track>:<historyPath>.
    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);

    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(rec.sliceId);
    expect(records[0]?.costUSD).toBe(rec.costUSD);
    expect(records[0]?.effort).toBe(rec.effort);
    expect(records[0]?.implementModel).toBe(rec.implementModel);
  });

  test("multiple records from successive slices all survive the commit round-trip", async () => {
    const absPath = join(workdir, HISTORY_PATH);

    for (const sliceId of [10, 20, 30]) {
      await appendCostRecord(absPath, makeRecord(sliceId));
      const commit = makeCommitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH, ACTOR);
      await commit();
    }

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.sliceId)).toEqual([10, 20, 30]);
  });

  test("idempotent: committing the same record twice does not duplicate it in the reader", async () => {
    const absPath = join(workdir, HISTORY_PATH);
    const rec = makeRecord(99);

    await appendCostRecord(absPath, rec);
    const commit = makeCommitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH, ACTOR);
    await commit();

    // Second call: appendCostRecord skips (idempotent), commit is a no-op.
    const second = await appendCostRecord(absPath, rec);
    expect(second).toBe(false); // already recorded
    await commit(); // no-op

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(99);
  });

  test("returns empty array when no history committed yet (first run before any slice)", async () => {
    // No appendCostRecord, no commit.
    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toEqual([]);
  });

  test(".flowd/ in .gitignore does not prevent the record from reaching the track branch", async () => {
    // This test specifically guards against the `git add` (without -f) silent-skip
    // bug.  The bootstrapped repo's .gitignore lists `.flowd/`, so a plain
    // `git add` would silently skip the file and the record would never be
    // committed.  `git add -f` must be used instead.
    const absPath = join(workdir, HISTORY_PATH);
    await appendCostRecord(absPath, makeRecord(7));

    const commit = makeCommitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH, ACTOR);
    await commit();

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    // If git add -f is NOT used, records will be empty because the gitignored
    // file was never staged → never committed → git show returns nothing.
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(7);
  });
});

// ── Tests: readCostRecordsFromGit edge cases ──────────────────────────────────

describe("readCostRecordsFromGit edge cases", () => {
  let workdir: string;
  let bareOrigin: string;

  beforeEach(async () => {
    bareOrigin = await initBareOrigin();
    workdir = await cloneWorkdir(bareOrigin);
    await bootstrapRepo(workdir, TRACK_BRANCH);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(bareOrigin, { recursive: true, force: true });
  });

  test("returns [] when workdir does not exist", async () => {
    const missing = join(tmpdir(), "flowd-does-not-exist-xyz-12345");
    const records = await readCostRecordsFromGit(missing, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toEqual([]);
  });

  test("returns only valid records when the committed file contains malformed JSONL lines", async () => {
    // Commit a JSONL file that mixes valid and invalid lines directly, bypassing
    // appendCostRecord, so we can inject the malformed content.
    const validRec = makeRecord(55);
    const mixed = `${JSON.stringify(validRec)}\nnot-json-at-all\n{"broken": true, "missing-sliceId"}\n{"sliceId": "wrong-type"}\n`; // sliceId must be number — filtered

    const absHistoryPath = join(workdir, HISTORY_PATH);
    await mkdir(join(workdir, ".flowd"), { recursive: true });
    await writeFile(absHistoryPath, mixed, "utf8");

    // Stage with -f because .flowd/ is gitignored.
    await $`git -C ${workdir} add -f ${HISTORY_PATH}`.quiet();
    await $`git -C ${workdir} -c user.name=${ACTOR} -c user.email=${ACTOR}@flowd commit -m "test: malformed jsonl"`.quiet();
    await $`git -C ${workdir} push origin ${TRACK_BRANCH}`.quiet();

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    // Only the one valid record (sliceId=55) should survive; malformed lines skipped.
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(55);
  });

  test("returns [] when relHistoryPath resolves outside the repo (git show fails)", async () => {
    // Pass an absolute path that lives outside the workdir.  resolve(workdir,
    // absPath) returns the absolute path unchanged, relative() produces a
    // traversal like "../../...", and git show rejects it → returns [].
    const outsidePath = join(tmpdir(), "outside-flowd.jsonl");
    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, outsidePath);
    expect(records).toEqual([]);
  });
});
