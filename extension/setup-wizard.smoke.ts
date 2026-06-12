/**
 * Smoke check for the /flow-setup wizard. Run with:
 *   bun extension/setup-wizard.smoke.ts
 *
 * Drives `runSetupWizard` against fakes (scripted UI answers + in-memory
 * dep stubs). Covers:
 *   - Happy path: defaults-accepted run executes all seven steps and
 *     returns ok=true with the expected step outputs in summary.
 *   - Preflight failure halts before labels (no labels.apply call).
 *   - Existing profile halts with hint about --edit/--reset (no
 *     labels.apply, no scaffold call).
 *   - Override path: user declines defaults, every ui.input answer is
 *     fed to scaffold.run as `answers`.
 *   - Smoke-test failure (gh issue list non-zero) → outcome still ok=true
 *     (setup is done, smoke is informational), smokeTestOk=false.
 *   - defaultBranch probe falls back to 'main' on gh failure.
 */

import { runSetupWizard, type WizardUi, type WizardDeps } from "./setup-wizard.ts";
import type { Preflight, PreflightResult } from "./preflight.ts";
import type { SetupLabels, ApplyLabelsResult } from "./setup-labels.ts";
import type { SetupTemplates, ApplyTemplatesResult } from "./setup-templates.ts";
import type { ScaffoldProfile, ScaffoldResult, ScaffoldAnswers } from "./scaffold-profile.ts";
import type { Gh } from "./gh.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- Fakes ---------------------------------------------------------------

type UiCall =
  | { kind: "input"; prompt: string; answer: string | undefined }
  | { kind: "confirm"; title: string; answer: boolean }
  | { kind: "select"; prompt: string; answer: string | undefined }
  | { kind: "notify"; text: string; level: string };

type ScriptedAnswer =
  | { kind: "input"; answer: string | undefined }
  | { kind: "confirm"; answer: boolean }
  | { kind: "select"; answer: string | undefined };

function makeUi(script: ScriptedAnswer[]): { ui: WizardUi; calls: UiCall[] } {
  const calls: UiCall[] = [];
  let cursor = 0;
  function pop(kind: ScriptedAnswer["kind"]) {
    const a = script[cursor++];
    if (!a) throw new Error(`UI script exhausted at ${kind} call #${cursor}`);
    if (a.kind !== kind)
      throw new Error(`UI script expected ${a.kind} but got ${kind} at #${cursor}`);
    return a;
  }
  const ui: WizardUi = {
    async input(prompt, placeholder) {
      const a = pop("input") as Extract<ScriptedAnswer, { kind: "input" }>;
      calls.push({ kind: "input", prompt, answer: a.answer });
      return a.answer;
    },
    async confirm(title, _message) {
      const a = pop("confirm") as Extract<ScriptedAnswer, { kind: "confirm" }>;
      calls.push({ kind: "confirm", title, answer: a.answer });
      return a.answer;
    },
    async select(prompt, _opts) {
      const a = pop("select") as Extract<ScriptedAnswer, { kind: "select" }>;
      calls.push({ kind: "select", prompt, answer: a.answer });
      return a.answer;
    },
    notify(text, level = "info") {
      calls.push({ kind: "notify", text, level });
    },
  };
  return { ui, calls };
}

function makePreflight(result: PreflightResult): Preflight {
  return { async run() { return result; } };
}

function makeLabels(result: ApplyLabelsResult): { labels: SetupLabels; called: number } {
  const state = { called: 0 };
  return {
    get called() { return state.called; },
    labels: {
      async apply() {
        state.called++;
        return result;
      },
    },
  };
}

function makeTemplates(result: ApplyTemplatesResult): {
  templates: SetupTemplates;
  called: number;
} {
  const state = { called: 0 };
  return {
    get called() { return state.called; },
    templates: {
      async apply() {
        state.called++;
        return result;
      },
    },
  };
}

function makeScaffold(result: ScaffoldResult): {
  scaffold: ScaffoldProfile;
  called: ScaffoldAnswers[];
} {
  const seen: ScaffoldAnswers[] = [];
  return {
    called: seen,
    scaffold: {
      async run(answers) {
        seen.push(answers);
        return result;
      },
    },
  };
}

type GhScript = Array<{ matchArg: string; reply: { stdout?: string; stderr?: string; code: number } }>;
function makeGh(script: GhScript): Gh {
  return {
    async run(args) {
      for (const s of script) {
        if (args.includes(s.matchArg)) {
          return {
            stdout: s.reply.stdout ?? "",
            stderr: s.reply.stderr ?? "",
            code: s.reply.code,
          };
        }
      }
      throw new Error(`gh stub: no script entry for ${args.join(" ")}`);
    },
    listIssues: async () => { throw new Error("not stubbed"); },
    viewIssue: async () => { throw new Error("not stubbed"); },
    editIssueLabels: async () => { throw new Error("not stubbed"); },
    commentOnIssue: async () => { throw new Error("not stubbed"); },
  };
}

const OK_PREFLIGHT: PreflightResult = {
  ok: true,
  ghAuthed: true,
  ghUser: "CaribouJohn",
  owner: "CaribouJohn",
  repo: "pi-flow",
  errors: [],
};

const FAIL_PREFLIGHT: PreflightResult = {
  ok: false,
  ghAuthed: false,
  errors: [
    { code: "gh_not_authed", message: "gh is not authenticated for github.com." },
  ],
};

const ZERO_LABELS: ApplyLabelsResult = {
  created: ["bug", "enhancement"],
  alreadyPresent: [],
  skippedDueToDryRun: [],
  drift: [],
};

const ZERO_TEMPLATES: ApplyTemplatesResult = {
  written: ["triage.yml", "tracking.yml", "slice.yml"],
  skippedExisting: [],
};

// --- Happy path: defaults accepted ---------------------------------------

{
  const { ui, calls } = makeUi([{ kind: "confirm", answer: true }]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "/repo/.pi/flow.profile.md" });
  const gh = makeGh([
    { matchArg: "repo", reply: { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    { matchArg: "issue", reply: { code: 0, stdout: "" } },
  ]);

  const deps: WizardDeps = {
    cwd: "/repo",
    ui,
    preflight: makePreflight(OK_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh,
    profileExists: () => false,
  };

  const r = await runSetupWizard(deps);
  check("happy: ok=true", r.ok === true);
  if (r.ok) {
    check("happy: labels called once", labels.called === 1);
    check("happy: templates called once", templates.called === 1);
    check(
      "happy: scaffold called with detected owner/repo/branch",
      scaffold.called.length === 1 &&
        scaffold.called[0]!.owner === "CaribouJohn" &&
        scaffold.called[0]!.repo === "pi-flow" &&
        scaffold.called[0]!.defaultBranch === "main",
    );
    check("happy: smokeTestOk=true", r.smokeTestOk === true);
    check(
      "happy: summary mentions all seven steps",
      ["Step 1/7", "Step 2/7", "Step 3/7", "Step 4/7", "Step 5/7", "Step 6/7", "Step 7/7"].every(
        (s) => r.summary.some((line) => line.includes(s)),
      ),
    );
  }
  check(
    "happy: exactly one confirm dialog (no override prompts)",
    calls.filter((c) => c.kind === "confirm").length === 1 &&
      calls.filter((c) => c.kind === "input").length === 0,
  );
}

// --- Preflight failure halts ---------------------------------------------

{
  const { ui } = makeUi([]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "x" });

  const r = await runSetupWizard({
    cwd: "/repo",
    ui,
    preflight: makePreflight(FAIL_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh: makeGh([]),
    profileExists: () => false,
  });
  check("preflight fail: ok=false, reason='preflight'", r.ok === false && r.reason === "preflight");
  check("preflight fail: labels NOT called", labels.called === 0);
  check("preflight fail: scaffold NOT called", scaffold.called.length === 0);
  check(
    "preflight fail: every preflight error appears in summary",
    r.summary.some((l) => l.includes("gh_not_authed")),
  );
}

// --- Existing profile halts ----------------------------------------------

{
  const { ui } = makeUi([]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "x" });

  const r = await runSetupWizard({
    cwd: "/repo",
    ui,
    preflight: makePreflight(OK_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh: makeGh([]),
    profileExists: () => true,
  });
  check(
    "exists: ok=false, reason='profile-exists'",
    r.ok === false && r.reason === "profile-exists",
  );
  check("exists: labels NOT called", labels.called === 0);
  check("exists: scaffold NOT called", scaffold.called.length === 0);
  check(
    "exists: hint mentions --edit and --reset",
    r.summary.some((l) => /--edit/.test(l) && /--reset/.test(l)),
  );
}

// --- Override path: user declines defaults -------------------------------

{
  const { ui, calls } = makeUi([
    { kind: "confirm", answer: false }, // refuse defaults
    { kind: "input", answer: "OtherOwner" },
    { kind: "input", answer: "other-repo" },
    { kind: "input", answer: "develop" },
    { kind: "input", answer: "bun test" },
    { kind: "input", answer: "/my-review" },
    { kind: "input", answer: "> custom disclaimer" },
  ]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "/repo/.pi/flow.profile.md" });
  const gh = makeGh([
    { matchArg: "repo", reply: { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    { matchArg: "issue", reply: { code: 0, stdout: "" } },
  ]);

  const r = await runSetupWizard({
    cwd: "/repo",
    ui,
    preflight: makePreflight(OK_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh,
    profileExists: () => false,
  });
  check("override: ok=true", r.ok === true);
  check("override: 6 ui.input calls (one per override field)", calls.filter((c) => c.kind === "input").length === 6);
  check(
    "override: scaffold receives override values",
    scaffold.called[0]!.owner === "OtherOwner" &&
      scaffold.called[0]!.repo === "other-repo" &&
      scaffold.called[0]!.defaultBranch === "develop" &&
      scaffold.called[0]!.verifyGate === "bun test" &&
      scaffold.called[0]!.reviewerCommand === "/my-review" &&
      scaffold.called[0]!.aiDisclaimer === "> custom disclaimer",
    JSON.stringify(scaffold.called[0]),
  );
}

// --- Smoke test failure surfaces but doesn't abort -----------------------

{
  const { ui } = makeUi([{ kind: "confirm", answer: true }]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "x" });
  const gh = makeGh([
    { matchArg: "repo", reply: { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    { matchArg: "issue", reply: { code: 1, stderr: "boom" } },
  ]);

  const r = await runSetupWizard({
    cwd: "/repo",
    ui,
    preflight: makePreflight(OK_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh,
    profileExists: () => false,
  });
  check("smoke-fail: outcome still ok=true (setup completed)", r.ok === true);
  if (r.ok) {
    check("smoke-fail: smokeTestOk=false", r.smokeTestOk === false);
    check(
      "smoke-fail: summary contains FAIL line for smoke test",
      r.summary.some((l) => /smoke test: FAIL/.test(l)),
    );
  }
}

// --- defaultBranch probe fallback ----------------------------------------

{
  const { ui } = makeUi([{ kind: "confirm", answer: true }]);
  const labels = makeLabels(ZERO_LABELS);
  const templates = makeTemplates(ZERO_TEMPLATES);
  const scaffold = makeScaffold({ written: true, path: "x" });
  const gh = makeGh([
    { matchArg: "repo", reply: { code: 1, stderr: "no auth" } }, // probe fails
    { matchArg: "issue", reply: { code: 0, stdout: "" } },
  ]);

  const r = await runSetupWizard({
    cwd: "/repo",
    ui,
    preflight: makePreflight(OK_PREFLIGHT),
    labels: labels.labels,
    templates: templates.templates,
    scaffold: scaffold.scaffold,
    gh,
    profileExists: () => false,
  });
  check(
    "branch-probe fallback: defaultBranch=='main'",
    r.ok === true && scaffold.called[0]!.defaultBranch === "main",
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
