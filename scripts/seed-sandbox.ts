#!/usr/bin/env bun
/**
 * Seed (idempotently) the sandbox fixture repo that the walking skeleton's
 * flowd operates on. flowd's CODE lives in pi-flow; this repo is only its
 * runtime target — a deterministic, planted track so the skeleton's pass/fail
 * is obvious and a wrong merge harms nothing (PRD-0001 §8).
 *
 * Seeds: the Flow label set; a minimal verifiable project on `main`; a track
 * branch; a `tracking` parent issue; and one `ready-for-agent` slice
 * ("add add(a,b) + test"). Re-runnable — every step checks before it writes.
 *
 *   bun scripts/seed-sandbox.ts            # default repo
 *   SANDBOX_REPO=owner/name bun scripts/seed-sandbox.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const REPO = process.env.SANDBOX_REPO ?? "CaribouJohn/pi-flow-sandbox";
const TRACK_BRANCH = "track/sandbox-demo";

const LABELS: { name: string; color: string; description: string }[] = [
  { name: "tracking", color: "0052cc", description: "Tracking parent; never worked directly" },
  { name: "ready-for-agent", color: "0e8a16", description: "An agent can execute it unattended" },
  { name: "ready-for-human", color: "5319e7", description: "A human must implement it" },
  { name: "needs-acceptance", color: "1f6feb", description: "Human accept-or-reject gate" },
  { name: "effort:low", color: "c2e0c6", description: "Mechanical" },
  { name: "effort:medium", color: "fef2c0", description: "Specified but needs care" },
  { name: "effort:high", color: "f9d0c4", description: "Reasoning-heavy" },
  { name: "review:agent", color: "c5def5", description: "Independent reviewer agent gates merge" },
  { name: "review:human", color: "1d76db", description: "Escalate to a human reviewer" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
];

const SLICE_TITLE = "add add(a, b) returning a + b, with a unit test";
const PARENT_TITLE = "Sandbox demo track";

async function main(): Promise<void> {
  console.log(`Seeding sandbox ${REPO}…`);
  await ensureLabels();
  await ensureMainProject();
  await ensureTrackBranch();
  const parent = await ensureIssue(PARENT_TITLE, ["tracking", "enhancement"], parentBody());
  await ensureIssue(
    SLICE_TITLE,
    ["ready-for-agent", "effort:low", "review:agent"],
    sliceBody(parent),
  );
  console.log(`\nDone. Planted track #${parent} on ${REPO} (branch ${TRACK_BRANCH}).`);
}

async function ensureLabels(): Promise<void> {
  for (const l of LABELS) {
    // --force creates the label or updates it if it already exists.
    await $`gh label create ${l.name} --repo ${REPO} --color ${l.color} --description ${l.description} --force`.quiet();
  }
  console.log(`  labels: ${LABELS.length} ensured`);
}

async function ensureMainProject(): Promise<void> {
  if (await branchHasFile("main", "package.json")) {
    console.log("  main project: already seeded");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "pf-sandbox-"));
  try {
    await $`git clone https://github.com/${REPO}.git ${dir}`.quiet();
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, "package.json"), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`);
    await writeFile(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
    await writeFile(join(dir, "README.md"), README);
    await writeFile(join(dir, "src", "index.ts"), SRC_INDEX);
    await writeFile(join(dir, "test", "sanity.test.ts"), SANITY_TEST);
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -m ${"chore: seed minimal verifiable project"}`.quiet();
    await $`git -C ${dir} push origin HEAD:main`.quiet();
    console.log("  main project: seeded (package.json, src, test, verify=bun test)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ensureTrackBranch(): Promise<void> {
  const existing =
    await $`git ls-remote --heads https://github.com/${REPO}.git ${TRACK_BRANCH}`.text();
  if (existing.trim().length > 0) {
    console.log(`  track branch ${TRACK_BRANCH}: already exists`);
    return;
  }
  const main = (await $`git ls-remote https://github.com/${REPO}.git main`.text()).split(/\s+/)[0];
  await $`gh api repos/${REPO}/git/refs -f ref=${`refs/heads/${TRACK_BRANCH}`} -f sha=${main}`.quiet();
  console.log(`  track branch ${TRACK_BRANCH}: created off main`);
}

async function ensureIssue(title: string, labels: string[], body: string): Promise<number> {
  const found = await findIssue(title);
  if (found !== null) {
    console.log(`  issue "${title}": #${found} (exists)`);
    return found;
  }
  const url =
    await $`gh issue create --repo ${REPO} --title ${title} --label ${labels.join(",")} --body ${body}`.text();
  const num = Number(url.trim().split("/").pop());
  console.log(`  issue "${title}": #${num} (created)`);
  return num;
}

async function findIssue(title: string): Promise<number | null> {
  const json =
    await $`gh issue list --repo ${REPO} --state all --search ${`"${title}" in:title`} --json number,title`.text();
  const issues = JSON.parse(json) as { number: number; title: string }[];
  return issues.find((i) => i.title === title)?.number ?? null;
}

async function branchHasFile(branch: string, path: string): Promise<boolean> {
  const res = await $`gh api repos/${REPO}/contents/${path}?ref=${branch}`.quiet().nothrow();
  return res.exitCode === 0;
}

const PACKAGE_JSON = {
  name: "pi-flow-sandbox",
  version: "0.0.0",
  private: true,
  type: "module",
  scripts: { verify: "bun test" },
};

const SRC_INDEX = `// Sandbox source. The planted slice adds add(a, b) here.\nexport const SANDBOX = "ready";\n`;

const SANITY_TEST = `import { expect, test } from "bun:test";
import { SANDBOX } from "../src/index.ts";

test("sandbox is ready", () => {
  expect(SANDBOX).toBe("ready");
});
`;

const README = `# pi-flow-sandbox

Throwaway runtime fixture for the pi-flow walking skeleton. flowd operates on
this repo; flowd's code lives in pi-flow. Re-seed with \`bun scripts/seed-sandbox.ts\`.
`;

function parentBody(): string {
  return `🤖 Posted by pi-flow on behalf of @CaribouJohn

Sandbox demo **tracking** parent for the walking skeleton. Its child slices run on \`${TRACK_BRANCH}\`. Not worked directly.`;
}

function sliceBody(parent: number): string {
  return `🤖 Posted by pi-flow on behalf of @CaribouJohn

## Parent
#${parent}

## What to build
Add an \`add(a, b)\` function to \`src/index.ts\` that returns \`a + b\`, with a unit test in \`test/add.test.ts\`.

## Verification
\`bun run verify\` (runs \`bun test\`) is green.

## Blocked by
None - can start immediately`;
}

await main();
