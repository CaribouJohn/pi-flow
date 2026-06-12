/**
 * `/flow-setup` interactive bootstrap (C5). Fresh-repo happy path.
 *
 * Procedural — does **not** invoke the LLM. Drives `ctx.ui` dialogs
 * directly and calls the C1–C4 factory functions in-process (no tool
 * round-trip). The setup-flow skill prompt (rewritten in C7) is what
 * the LLM consults when asked about setup; this command is what the
 * skill points at.
 *
 * Flow:
 *   1. Preflight (gh auth + origin parse). On fail → notify + stop.
 *   2. Refuse if .pi/flow.profile.md already exists (edit / reset = C6).
 *   3. Apply canonical labels.
 *   4. Interview — confirm detected owner/repo/defaultBranch, or override
 *      each field one by one.
 *   5. Scaffold profile from collected answers.
 *   6. Apply issue templates.
 *   7. Smoke test: `gh issue list -l ready-for-agent --limit 1`.
 *   8. Print next-steps (commit hint + pointers to /flow-next, /flow-afk).
 *
 * Every step pushes a line into `summary[]` and notifies; the final
 * summary is returned for the command handler to display.
 *
 * The factory takes injectable seams (ui, preflight, labels, templates,
 * scaffold, gh, fs-exists) so the smoke test scripts answers and asserts
 * the call sequence against fakes.
 */

import { join } from "node:path";
import type { Preflight, PreflightResult } from "./preflight.ts";
import type { SetupLabels, ApplyLabelsResult } from "./setup-labels.ts";
import type { SetupTemplates, ApplyTemplatesResult } from "./setup-templates.ts";
import type { ScaffoldProfile, ScaffoldAnswers } from "./scaffold-profile.ts";
import {
  DEFAULT_AI_DISCLAIMER,
  DEFAULT_REVIEWER_COMMAND,
  DEFAULT_VERIFY_GATE,
} from "./scaffold-profile.ts";
import type { Gh } from "./gh.ts";
import { GhError } from "./gh.ts";

// --- UI seam --------------------------------------------------------------

/** Subset of `ctx.ui` the wizard needs. Mirrors the docs surface. */
export type WizardUi = {
  input(prompt: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  select(prompt: string, options: string[]): Promise<string | undefined>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
};

// --- Result ---------------------------------------------------------------

export type WizardOutcome =
  | { ok: false; reason: "preflight"; preflight: PreflightResult; summary: string[] }
  | { ok: false; reason: "profile-exists"; profilePath: string; summary: string[] }
  | { ok: false; reason: "cancelled"; summary: string[] }
  | {
      ok: true;
      preflight: PreflightResult;
      labels: ApplyLabelsResult;
      answers: ScaffoldAnswers;
      profilePath: string;
      templates: ApplyTemplatesResult;
      smokeTestOk: boolean;
      summary: string[];
    };

// --- Deps -----------------------------------------------------------------

export type WizardDeps = {
  cwd: string;
  ui: WizardUi;
  preflight: Preflight;
  labels: SetupLabels;
  templates: SetupTemplates;
  scaffold: ScaffoldProfile;
  gh: Gh;
  /** Check whether `.pi/flow.profile.md` already exists. */
  profileExists: () => boolean;
  signal?: AbortSignal;
};

// --- Defaults probing -----------------------------------------------------

/**
 * Ask `gh` for the repo's default branch. Falls back to `'main'` if `gh`
 * fails or the response is malformed — we don't want a network blip to
 * abort the wizard, the user can override during the interview.
 */
async function probeDefaultBranch(
  gh: Gh,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const r = await gh.run(
      ["repo", "view", "--json", "defaultBranchRef"],
      { signal },
    );
    if (r.code !== 0) return "main";
    const parsed = JSON.parse(r.stdout) as {
      defaultBranchRef?: { name?: string };
    };
    const name = parsed?.defaultBranchRef?.name;
    return typeof name === "string" && name !== "" ? name : "main";
  } catch {
    return "main";
  }
}

// --- The wizard -----------------------------------------------------------

export async function runSetupWizard(deps: WizardDeps): Promise<WizardOutcome> {
  const summary: string[] = [];
  const log = (line: string, level: "info" | "warning" | "error" = "info") => {
    summary.push(line);
    deps.ui.notify(line, level);
  };

  // 1. Preflight
  log("Step 1/7: preflight (gh auth + origin)");
  const pf = await deps.preflight.run({ signal: deps.signal });
  if (!pf.ok) {
    for (const e of pf.errors) log(`  [${e.code}] ${e.message}`, "error");
    log("Preflight failed; setup aborted.", "error");
    return { ok: false, reason: "preflight", preflight: pf, summary };
  }
  log(
    `  ok — gh: ${pf.ghUser ?? "(authed)"}, repo: ${pf.owner}/${pf.repo}`,
  );

  // 2. Profile-existence guard
  const profilePath = join(deps.cwd, ".pi", "flow.profile.md");
  if (deps.profileExists()) {
    log(
      `Profile already exists at ${profilePath} — use '/flow-setup --edit' or '/flow-setup --reset' (C6) instead. Aborting.`,
      "warning",
    );
    return { ok: false, reason: "profile-exists", profilePath, summary };
  }

  // 3. Labels
  log("Step 2/7: apply canonical labels");
  const labelsResult = await deps.labels.apply({ signal: deps.signal });
  log(
    `  ${labelsResult.created.length} created, ${labelsResult.alreadyPresent.length} already present` +
      (labelsResult.drift.length > 0
        ? `, ${labelsResult.drift.length} drift (reported, not corrected)`
        : ""),
  );

  // 4. Interview
  log("Step 3/7: interview");
  const defaultBranch = await probeDefaultBranch(deps.gh, deps.signal);

  const acceptDefaults = await deps.ui.confirm(
    "Setup wizard — confirm defaults",
    `Use detected values?\n  owner: ${pf.owner}\n  repo: ${pf.repo}\n  default branch: ${defaultBranch}\n\n` +
      "Yes = use them and the standard profile defaults.\n" +
      "No = walk through every field.",
  );

  let answers: ScaffoldAnswers;
  if (acceptDefaults) {
    answers = {
      owner: pf.owner!,
      repo: pf.repo!,
      defaultBranch,
    };
    log("  using detected defaults");
  } else {
    const owner =
      (await deps.ui.input("GitHub owner:", pf.owner)) ?? pf.owner!;
    const repo =
      (await deps.ui.input("GitHub repo:", pf.repo)) ?? pf.repo!;
    const branch =
      (await deps.ui.input("Default branch:", defaultBranch)) ?? defaultBranch;
    const verifyGate =
      (await deps.ui.input(
        "Verify gate (lint + typecheck + test command):",
        DEFAULT_VERIFY_GATE,
      )) ?? DEFAULT_VERIFY_GATE;
    const reviewerCommand =
      (await deps.ui.input(
        "Reviewer-agent slash command:",
        DEFAULT_REVIEWER_COMMAND,
      )) ?? DEFAULT_REVIEWER_COMMAND;
    const aiDisclaimer =
      (await deps.ui.input(
        "AI disclaimer prefix for posted comments:",
        DEFAULT_AI_DISCLAIMER,
      )) ?? DEFAULT_AI_DISCLAIMER;

    answers = {
      owner,
      repo,
      defaultBranch: branch,
      verifyGate,
      reviewerCommand,
      aiDisclaimer,
    };
    log(`  collected overrides for ${owner}/${repo}`);
  }

  // 5. Scaffold profile
  log("Step 4/7: scaffold .pi/flow.profile.md");
  const sc = await deps.scaffold.run(answers);
  if (!sc.written) {
    // Shouldn't happen — we guarded above. But surface cleanly if some
    // racy state created the file between the guard and here.
    log(
      `  unexpected: profile already present (${sc.reason}). Aborting.`,
      "error",
    );
    return {
      ok: false,
      reason: "profile-exists",
      profilePath: sc.path,
      summary,
    };
  }
  log(`  wrote ${sc.path} (uncommitted)`);

  // 6. Issue templates
  log("Step 5/7: apply issue templates");
  const tpl = await deps.templates.apply();
  log(
    `  ${tpl.written.length} written, ${tpl.skippedExisting.length} skipped (already present)`,
  );

  // 7. Smoke test
  log("Step 6/7: smoke test — gh issue list -l ready-for-agent --limit 1");
  let smokeOk = false;
  try {
    const r = await deps.gh.run(
      ["issue", "list", "-l", "ready-for-agent", "--limit", "1"],
      { signal: deps.signal },
    );
    if (r.code === 0) {
      smokeOk = true;
      log("  smoke test: PASS");
    } else {
      log(
        `  smoke test: FAIL (gh exit ${r.code}) — ${r.stderr.trim()}`,
        "warning",
      );
    }
  } catch (err) {
    const msg =
      err instanceof GhError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log(`  smoke test: ERROR — ${msg}`, "warning");
  }

  // 8. Next steps
  log("Step 7/7: next steps");
  log("  git add .pi/flow.profile.md .github/ISSUE_TEMPLATE/");
  log("  git commit -m 'chore: adopt pi-flow'");
  log("  Then try: /flow-next   (the agent-assignable queue)");
  log("         or /flow-status (track health overview)");

  return {
    ok: true,
    preflight: pf,
    labels: labelsResult,
    answers,
    profilePath: sc.path,
    templates: tpl,
    smokeTestOk: smokeOk,
    summary,
  };
}
