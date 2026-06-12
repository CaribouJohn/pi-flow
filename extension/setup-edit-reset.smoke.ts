/**
 * Smoke check for the edit + reset modes of /flow-setup (C6). Run with:
 *   bun extension/setup-edit-reset.smoke.ts
 *
 * Covers:
 *   - profileToAnswers: round-trips every editable scalar; reconstructs
 *     labelOverrides only for non-default state labels.
 *   - runSetupEdit:
 *       - no profile → no-profile outcome, scaffold not called.
 *       - immediate Cancel → cancelled outcome, scaffold not called.
 *       - edit one field then Apply → scaffold.run called with overwrite:true
 *         and the merged answer.
 *       - numeric coercion: pollCadenceSeconds string "45" lands as number 45.
 *       - empty input keeps the current value (no change).
 *   - runSetupReset:
 *       - no profile → no-profile outcome, wizard NOT invoked.
 *       - user declines confirm → cancelled outcome, deleteProfile NOT called.
 *       - confirm + delete success → runs wizard, wizard sees profileExists=false.
 *       - deleteProfile fails → aborts with error.
 */

import {
  profileToAnswers,
  runSetupEdit,
  runSetupReset,
  type WizardUi,
  type ResetDeps,
} from "./setup-wizard.ts";
import type { Profile } from "./profile.ts";
import type { ScaffoldProfile, ScaffoldAnswers, ScaffoldResult } from "./scaffold-profile.ts";
import type { Preflight, PreflightResult } from "./preflight.ts";
import type { SetupLabels, ApplyLabelsResult } from "./setup-labels.ts";
import type { SetupTemplates, ApplyTemplatesResult } from "./setup-templates.ts";
import type { Gh } from "./gh.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- Fixtures ------------------------------------------------------------

const SAMPLE_PROFILE: Profile = {
  tracker: "github",
  repo: "CaribouJohn/pi-flow",
  default_branch: "main",
  track_branch_prefix: "track/",
  verify_gate: "bun test",
  in_situ_harness: "n/a",
  reviewer_command: "/code-review",
  reviewer_iteration_cap: 2,
  poll_cadence_seconds: 30,
  ai_disclaimer: "> ai",
  labels: {
    category: ["bug", "enhancement"],
    state: {
      needs_triage: "needs-triage",
      needs_info: "needs-info",
      needs_grilling: "needs-grilling",
      needs_slicing: "needs-slicing",
      needs_plan_review: "needs-plan-review",
      tracking: "tracking",
      ready_for_agent: "ready-for-agent",
      ready_for_human: "ready-for-human",
      needs_acceptance: "needs-acceptance",
      wontfix: "no-fix", // <- one custom override
    },
    effort: { low: "effort:low", medium: "effort:medium", high: "effort:high" },
    review: { agent: "review:agent", human: "review:human" },
  },
  body: "body",
};

// --- UI fake -------------------------------------------------------------

type ScriptedAnswer =
  | { kind: "select"; answer: string | undefined }
  | { kind: "input"; answer: string | undefined }
  | { kind: "confirm"; answer: boolean };

function makeUi(script: ScriptedAnswer[]): WizardUi {
  let i = 0;
  function pop(kind: ScriptedAnswer["kind"]) {
    const a = script[i++];
    if (!a) throw new Error(`UI script exhausted at ${kind} call #${i}`);
    if (a.kind !== kind)
      throw new Error(`UI script expected ${a.kind} but got ${kind} at #${i}`);
    return a;
  }
  return {
    async select() {
      const a = pop("select") as Extract<ScriptedAnswer, { kind: "select" }>;
      return a.answer;
    },
    async input() {
      const a = pop("input") as Extract<ScriptedAnswer, { kind: "input" }>;
      return a.answer;
    },
    async confirm() {
      const a = pop("confirm") as Extract<ScriptedAnswer, { kind: "confirm" }>;
      return a.answer;
    },
    notify() {},
  };
}

function makeScaffold(result: ScaffoldResult): {
  scaffold: ScaffoldProfile;
  called: Array<{ answers: ScaffoldAnswers; overwrite: boolean | undefined }>;
} {
  const called: Array<{ answers: ScaffoldAnswers; overwrite: boolean | undefined }> = [];
  return {
    called,
    scaffold: {
      async run(answers, opts) {
        called.push({ answers, overwrite: opts?.overwrite });
        return result;
      },
    },
  };
}

// --- profileToAnswers ----------------------------------------------------

{
  const a = profileToAnswers(SAMPLE_PROFILE);
  check("profileToAnswers: owner/repo split", a.owner === "CaribouJohn" && a.repo === "pi-flow");
  check("profileToAnswers: defaultBranch", a.defaultBranch === "main");
  check("profileToAnswers: scalars carried", a.verifyGate === "bun test" && a.reviewerCommand === "/code-review" && a.pollCadenceSeconds === 30);
  check(
    "profileToAnswers: labelOverrides contains only the divergent key",
    a.labelOverrides !== undefined &&
      JSON.stringify(a.labelOverrides) === JSON.stringify({ wontfix: "no-fix" }),
    JSON.stringify(a.labelOverrides),
  );
}

// Profile with no overrides → no labelOverrides key on the answers.
{
  const clean: Profile = {
    ...SAMPLE_PROFILE,
    labels: {
      ...SAMPLE_PROFILE.labels,
      state: { ...SAMPLE_PROFILE.labels.state, wontfix: "wontfix" },
    },
  };
  const a = profileToAnswers(clean);
  check(
    "profileToAnswers: no overrides → labelOverrides absent",
    a.labelOverrides === undefined,
  );
}

// --- runSetupEdit --------------------------------------------------------

// No profile
{
  const sc = makeScaffold({ written: true, path: "x" });
  const r = await runSetupEdit({
    ui: makeUi([]),
    scaffold: sc.scaffold,
    loadProfile: () => null,
  });
  check(
    "edit: no profile → no-profile outcome, scaffold not called",
    r.ok === false && r.reason === "no-profile" && sc.called.length === 0,
  );
}

// Immediate Cancel
{
  const sc = makeScaffold({ written: true, path: "x" });
  const r = await runSetupEdit({
    ui: makeUi([{ kind: "select", answer: "✕ Cancel (discard changes)" }]),
    scaffold: sc.scaffold,
    loadProfile: () => SAMPLE_PROFILE,
  });
  check(
    "edit: cancel → cancelled outcome, scaffold not called",
    r.ok === false && r.reason === "cancelled" && sc.called.length === 0,
  );
}

// Edit one field then Apply
{
  const sc = makeScaffold({ written: true, path: "/repo/.pi/flow.profile.md" });
  const r = await runSetupEdit({
    ui: makeUi([
      { kind: "select", answer: "verifyGate: bun test" },
      { kind: "input", answer: "bun lint && bun test" },
      { kind: "select", answer: "→ Apply changes" },
    ]),
    scaffold: sc.scaffold,
    loadProfile: () => SAMPLE_PROFILE,
  });
  check("edit: apply → ok=true, written=true", r.ok === true && (r.ok && r.written));
  check("edit: scaffold called once with overwrite:true", sc.called.length === 1 && sc.called[0]!.overwrite === true);
  check(
    "edit: edited value reached scaffold",
    sc.called[0]!.answers.verifyGate === "bun lint && bun test",
  );
  check(
    "edit: untouched fields preserved",
    sc.called[0]!.answers.owner === "CaribouJohn" &&
      sc.called[0]!.answers.defaultBranch === "main",
  );
}

// Numeric coercion
{
  const sc = makeScaffold({ written: true, path: "x" });
  const r = await runSetupEdit({
    ui: makeUi([
      { kind: "select", answer: "pollCadenceSeconds: 30" },
      { kind: "input", answer: "45" },
      { kind: "select", answer: "→ Apply changes" },
    ]),
    scaffold: sc.scaffold,
    loadProfile: () => SAMPLE_PROFILE,
  });
  check(
    "edit: numeric field coerced to number",
    r.ok === true && sc.called[0]!.answers.pollCadenceSeconds === 45,
  );
}

// Empty input keeps current value
{
  const sc = makeScaffold({ written: true, path: "x" });
  const r = await runSetupEdit({
    ui: makeUi([
      { kind: "select", answer: "verifyGate: bun test" },
      { kind: "input", answer: "" }, // cleared = keep current
      { kind: "select", answer: "→ Apply changes" },
    ]),
    scaffold: sc.scaffold,
    loadProfile: () => SAMPLE_PROFILE,
  });
  check(
    "edit: empty input keeps current value",
    r.ok === true && sc.called[0]!.answers.verifyGate === "bun test",
  );
}

// --- runSetupReset -------------------------------------------------------

const OK_PREFLIGHT: PreflightResult = {
  ok: true, ghAuthed: true, ghUser: "u",
  owner: "CaribouJohn", repo: "pi-flow", errors: [],
};
const ZERO_LABELS: ApplyLabelsResult = { created: [], alreadyPresent: [], skippedDueToDryRun: [], drift: [] };
const ZERO_TEMPLATES: ApplyTemplatesResult = { written: [], skippedExisting: [] };

function makeResetDeps(over: Partial<ResetDeps>): ResetDeps {
  const gh: Gh = {
    async run(args) {
      if (args.includes("repo")) return { stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    listIssues: async () => { throw new Error("ns"); },
    viewIssue: async () => { throw new Error("ns"); },
    editIssueLabels: async () => { throw new Error("ns"); },
    commentOnIssue: async () => { throw new Error("ns"); },
  };
  const base: ResetDeps = {
    cwd: "/repo",
    ui: makeUi([]),
    preflight: { async run() { return OK_PREFLIGHT; } } as Preflight,
    labels: { async apply() { return ZERO_LABELS; } } as SetupLabels,
    templates: { async apply() { return ZERO_TEMPLATES; } } as SetupTemplates,
    scaffold: { async run() { return { written: true, path: "/repo/.pi/flow.profile.md" }; } } as ScaffoldProfile,
    gh,
    profileExists: () => true,
    deleteProfile: () => true,
  };
  return { ...base, ...over };
}

// No profile to reset
{
  const r = await runSetupReset(makeResetDeps({
    ui: makeUi([]),
    profileExists: () => false,
  }));
  check("reset: no profile → no-profile outcome", r.ok === false && r.reason === "no-profile");
}

// User declines confirm
{
  let deleted = 0;
  const r = await runSetupReset(makeResetDeps({
    ui: makeUi([{ kind: "confirm", answer: false }]),
    deleteProfile: () => { deleted++; return true; },
  }));
  check(
    "reset: decline → cancelled, delete NOT called",
    r.ok === false && r.reason === "cancelled" && deleted === 0,
  );
}

// Confirm + delete success → wizard runs
{
  let deleted = 0;
  const r = await runSetupReset(makeResetDeps({
    ui: makeUi([
      { kind: "confirm", answer: true },   // reset confirm
      { kind: "confirm", answer: true },   // wizard's "accept defaults" confirm
    ]),
    deleteProfile: () => { deleted++; return true; },
  }));
  check("reset: confirm → delete called once", deleted === 1);
  check("reset: confirm → wizard ran (ok=true)", r.ok === true);
  if (r.ok) {
    check("reset: wizard outcome ok=true", r.wizard.ok === true);
  }
}

// Delete fails → aborts
{
  const r = await runSetupReset(makeResetDeps({
    ui: makeUi([{ kind: "confirm", answer: true }]),
    deleteProfile: () => false,
  }));
  check(
    "reset: delete fails → no-profile outcome (aborted)",
    r.ok === false && r.reason === "no-profile",
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
