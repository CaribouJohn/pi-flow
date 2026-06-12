/**
 * Smoke check for setup-labels. Run with:
 *   bun extension/setup-labels.smoke.ts
 *
 * Covers:
 *   - parseLabelsMarkdown against a multi-section fixture (skips header/
 *     separator rows, accepts backticked names, lowercases hex, rejects
 *     bad hex and duplicates).
 *   - createSetupLabels apply():
 *       - empty repo → every canonical label created (in order).
 *       - partial overlap → only missing names create-called; rest reported
 *         as alreadyPresent; create commands carry --color and --description.
 *       - drift detection on colour and description mismatch.
 *       - dryRun → no create calls; missing names go to skippedDueToDryRun.
 *       - GhError from `gh label list` propagates.
 *       - GhError from `gh label create` propagates (no further creates).
 */

import {
  parseLabelsMarkdown,
  createSetupLabels,
  type LabelSpec,
} from "./setup-labels.ts";
import type { Gh } from "./gh.ts";
import { GhError } from "./gh.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- parseLabelsMarkdown --------------------------------------------------

const FIXTURE_MD = `
# Canonical labels

## Category

| Name | Color | Description |
| --- | --- | --- |
| \`bug\` | d73a4a | Something isn't working |
| \`enhancement\` | A2EEEF | New feature or request |

## State

| Name | Color | Description |
| --- | --- | --- |
| \`ready-for-agent\` | 0e8a16 | Fully specified |
`;

{
  const parsed = parseLabelsMarkdown(FIXTURE_MD);
  check("parses 3 labels across 2 tables", parsed.length === 3, JSON.stringify(parsed));
  check(
    "preserves order across tables",
    parsed[0]!.name === "bug" &&
      parsed[1]!.name === "enhancement" &&
      parsed[2]!.name === "ready-for-agent",
  );
  check(
    "lowercases hex colours",
    parsed[1]!.color === "a2eeef",
    parsed[1]?.color,
  );
  check(
    "captures description verbatim",
    parsed[0]!.description === "Something isn't working",
  );
}

{
  let threw: Error | null = null;
  try {
    parseLabelsMarkdown("| `x` | notahex | desc |");
  } catch (e) {
    threw = e as Error;
  }
  check(
    "rejects non-hex colour",
    threw !== null && /invalid colour/i.test(threw!.message),
    threw?.message,
  );
}

{
  let threw: Error | null = null;
  try {
    parseLabelsMarkdown(
      "| `x` | 000000 | a |\n| `x` | 111111 | b |",
    );
  } catch (e) {
    threw = e as Error;
  }
  check(
    "rejects duplicate label name",
    threw !== null && /duplicate label/i.test(threw!.message),
    threw?.message,
  );
}

{
  let threw: Error | null = null;
  try {
    parseLabelsMarkdown("# heading only\n\nno tables here");
  } catch (e) {
    threw = e as Error;
  }
  check(
    "rejects fixture with no rows",
    threw !== null && /no label rows/i.test(threw!.message),
  );
}

// --- createSetupLabels.apply ---------------------------------------------

type RunCall = { args: string[] };

/** Build a stub Gh that records every `.run()` call and replies from a queue. */
function makeGh(
  replies: Array<{ stdout?: string; stderr?: string; code: number }>,
): { gh: Gh; calls: RunCall[] } {
  const calls: RunCall[] = [];
  let idx = 0;
  const gh: Gh = {
    async run(args) {
      calls.push({ args });
      const reply = replies[idx++];
      if (!reply) throw new Error(`gh.run: no scripted reply for ${args.join(" ")}`);
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: reply.code,
      };
    },
    listIssues: async () => { throw new Error("not stubbed"); },
    viewIssue: async () => { throw new Error("not stubbed"); },
    editIssueLabels: async () => { throw new Error("not stubbed"); },
    commentOnIssue: async () => { throw new Error("not stubbed"); },
  };
  return { gh, calls };
}

const CANONICAL: LabelSpec[] = parseLabelsMarkdown(FIXTURE_MD);
const loadCanonical = () => FIXTURE_MD;

// Empty repo → all three created
{
  const { gh, calls } = makeGh([
    { code: 0, stdout: "[]" },
    { code: 0, stdout: "" },
    { code: 0, stdout: "" },
    { code: 0, stdout: "" },
  ]);
  const s = createSetupLabels({ gh, loadCanonical });
  const r = await s.apply();
  check(
    "empty repo: created == canonical, no alreadyPresent, no drift",
    JSON.stringify(r.created) === JSON.stringify(CANONICAL.map((c) => c.name)) &&
      r.alreadyPresent.length === 0 &&
      r.drift.length === 0 &&
      r.skippedDueToDryRun.length === 0,
    JSON.stringify(r),
  );
  // 1 list call + 3 creates, in order.
  check("empty repo: 4 gh calls (list + 3 create)", calls.length === 4);
  check(
    "first call is label list with --json",
    calls[0]!.args[0] === "label" &&
      calls[0]!.args[1] === "list" &&
      calls[0]!.args.includes("--json"),
  );
  check(
    "create command shape: label create <name> --color <hex> --description <desc>",
    calls[1]!.args[0] === "label" &&
      calls[1]!.args[1] === "create" &&
      calls[1]!.args[2] === "bug" &&
      calls[1]!.args.includes("--color") &&
      calls[1]!.args.includes("d73a4a") &&
      calls[1]!.args.includes("--description") &&
      calls[1]!.args.includes("Something isn't working"),
    JSON.stringify(calls[1]),
  );
}

// Partial overlap → only missing one created; existing reported.
{
  const existing = JSON.stringify([
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  ]);
  const { gh, calls } = makeGh([
    { code: 0, stdout: existing },
    { code: 0, stdout: "" }, // only one create
  ]);
  const r = await createSetupLabels({ gh, loadCanonical }).apply();
  check(
    "partial overlap: created=[ready-for-agent], alreadyPresent has bug+enhancement",
    JSON.stringify(r.created) === JSON.stringify(["ready-for-agent"]) &&
      r.alreadyPresent.length === 2 &&
      r.alreadyPresent.includes("bug") &&
      r.alreadyPresent.includes("enhancement") &&
      r.drift.length === 0,
    JSON.stringify(r),
  );
  check("partial overlap: 2 gh calls (list + 1 create)", calls.length === 2);
  check(
    "create call targets the missing label only",
    calls[1]!.args.includes("ready-for-agent"),
  );
}

// Drift detection — colour and description divergence.
{
  const existing = JSON.stringify([
    { name: "bug", color: "FF0000", description: "wrong desc" },
    { name: "enhancement", color: "a2eeef", description: "New feature or request" },
    { name: "ready-for-agent", color: "0e8a16", description: "Fully specified" },
  ]);
  const { gh } = makeGh([{ code: 0, stdout: existing }]);
  const r = await createSetupLabels({ gh, loadCanonical }).apply();
  check(
    "drift: 1 entry for bug, no creates, all three alreadyPresent",
    r.created.length === 0 &&
      r.alreadyPresent.length === 3 &&
      r.drift.length === 1 &&
      r.drift[0]!.name === "bug" &&
      r.drift[0]!.canonical.color === "d73a4a" &&
      r.drift[0]!.actual.color === "ff0000",
    JSON.stringify(r.drift),
  );
}

// dryRun → no creates; missing names skipped.
{
  const { gh, calls } = makeGh([{ code: 0, stdout: "[]" }]);
  const r = await createSetupLabels({ gh, loadCanonical }).apply({ dryRun: true });
  check(
    "dryRun: skippedDueToDryRun == canonical, created empty",
    JSON.stringify(r.skippedDueToDryRun) ===
      JSON.stringify(CANONICAL.map((c) => c.name)) &&
      r.created.length === 0,
    JSON.stringify(r),
  );
  check("dryRun: only 1 gh call (the list)", calls.length === 1);
}

// gh label list failure propagates as GhError
{
  const { gh } = makeGh([{ code: 1, stderr: "boom" }]);
  let threw: unknown = null;
  try {
    await createSetupLabels({ gh, loadCanonical }).apply();
  } catch (e) {
    threw = e;
  }
  check(
    "label list failure → GhError",
    threw instanceof GhError && /gh label list/.test((threw as Error).message),
  );
}

// gh label create failure aborts mid-loop, no further creates
{
  const { gh, calls } = makeGh([
    { code: 0, stdout: "[]" },
    { code: 0 }, // bug create OK
    { code: 1, stderr: "rate-limited" }, // enhancement create fails
  ]);
  let threw: unknown = null;
  try {
    await createSetupLabels({ gh, loadCanonical }).apply();
  } catch (e) {
    threw = e;
  }
  check(
    "label create failure → GhError, names the label",
    threw instanceof GhError && /enhancement/.test((threw as Error).message),
  );
  check("label create failure: stops after the failing call", calls.length === 3);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
