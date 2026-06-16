/**
 * Integration test: cost-history writer path === calibrate reader path.
 *
 * Pins the invariant described in brief #163:
 *   "Writer (meter) and reader (calibrate) must resolve the same committed path."
 *
 * Setup: a bare "origin" repo + a workdir clone, mirroring what flowd manages
 * at runtime.  The test:
 *  1. Appends a record via `appendCostRecord` (the meter's write path).
 *  2. Commits and pushes to origin (what `makeCommitHistoryToTrack` does).
 *  3. Reads back via `readCostRecordsFromGit` (the calibrate read path).
 *  4. Asserts the record round-trips intact.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { $ } from "bun";
import { readCostRecordsFromGit } from "../src/calibrate.ts";
import { type CostHistoryRecord, appendCostRecord } from "../src/cost-meter.ts";

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

async function bootstrapRepo(workdir: string, trackBranch: string): Promise<void> {
  // Need at least one commit on main so origin/HEAD exists.
  await $`git -C ${workdir} commit --allow-empty -m "initial"`.quiet();
  await $`git -C ${workdir} push origin HEAD:main`.quiet();
  // Create and push the track branch.
  await $`git -C ${workdir} checkout -b ${trackBranch}`.quiet();
  await $`git -C ${workdir} push -u origin ${trackBranch}`.quiet();
}

/** Simulate what makeCommitHistoryToTrack does after appendCostRecord. */
async function commitHistoryToTrack(
  workdir: string,
  trackBranch: string,
  historyPath: string,
): Promise<void> {
  const absHistoryPath = resolve(workdir, historyPath);
  // git paths must use forward slashes even on Windows.
  const relHistoryPath = relative(workdir, absHistoryPath).replace(/\\/g, "/");

  const content = await readFile(absHistoryPath, "utf8").catch(() => "");
  if (content.trim().length === 0) return;

  await $`git -C ${workdir} fetch origin`.quiet();
  await $`git -C ${workdir} checkout -f -B ${trackBranch} origin/${trackBranch}`.quiet();

  await mkdir(dirname(absHistoryPath), { recursive: true });
  await writeFile(absHistoryPath, content, "utf8");
  await $`git -C ${workdir} add ${relHistoryPath}`.quiet();

  const diff = await $`git -C ${workdir} diff --cached --quiet`.nothrow().quiet();
  if (diff.exitCode === 0) return;

  const msg = "chore: update cost-history.jsonl";
  await $`git -C ${workdir} -c user.name=${ACTOR} -c user.email=${ACTOR}@flowd commit -m ${msg}`.quiet();
  await $`git -C ${workdir} push origin ${trackBranch}`.quiet();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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

    // Writer: append the record (meter's write path, using the absolute path
    // that resolves from workdir, matching what the chdir'd process sees).
    const appended = await appendCostRecord(absPath, rec);
    expect(appended).toBe(true);

    // Commit to origin/track (what makeCommitHistoryToTrack does).
    await commitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH);

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
      await commitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH);
    }

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.sliceId)).toEqual([10, 20, 30]);
  });

  test("idempotent: committing the same record twice does not duplicate it in the reader", async () => {
    const absPath = join(workdir, HISTORY_PATH);
    const rec = makeRecord(99);

    await appendCostRecord(absPath, rec);
    await commitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH);

    // Second call: appendCostRecord skips (idempotent), commit is a no-op.
    const second = await appendCostRecord(absPath, rec);
    expect(second).toBe(false); // already recorded
    await commitHistoryToTrack(workdir, TRACK_BRANCH, HISTORY_PATH); // no-op

    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toHaveLength(1);
    expect(records[0]?.sliceId).toBe(99);
  });

  test("returns empty array when no history committed yet (first run before any slice)", async () => {
    // No appendCostRecord, no commit.
    const records = await readCostRecordsFromGit(workdir, TRACK_BRANCH, HISTORY_PATH);
    expect(records).toEqual([]);
  });
});
