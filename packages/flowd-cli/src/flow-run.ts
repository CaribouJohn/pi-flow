import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  type AgentPort,
  type Effort,
  type OrchestratorPorts,
  type RunResult,
  type VerifyGatePort,
  runPlanGate,
  runTrack,
} from "@pi-flow/flow-engine";
import { $ } from "bun";
import type { FlowdConfig } from "./config.ts";
import { type CostEstimatorConfig, estimateTrackCost } from "./cost-estimator.ts";
import { CostMeterAdapter } from "./cost-meter.ts";
import { type CredentialStore, FileCredentialStore } from "./credentials.ts";
import { scrubProviderEnvKeys } from "./env-scrub.ts";
import { makeForgeGhRunner, makeForgeRunner, readForgeToken } from "./forge-auth.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";
import { PiImplementer } from "./pi-implementer.ts";
import { PiPlanReviewer } from "./pi-plan-reviewer.ts";
import { PiReviewer } from "./pi-reviewer.ts";

/** Runs a shell command in `cwd` and returns its exit code and combined output. */
export type ShellRunner = (
  command: string,
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

const realShell: ShellRunner = async (command, cwd) => {
  const res = await $`sh -c ${command}`.cwd(cwd).nothrow();
  const output = [res.stdout, res.stderr]
    .map((b) => b.toString())
    .join("")
    .trimEnd();
  return { exitCode: res.exitCode, output };
};

/** Maximum number of characters retained from verify output in a park comment. */
const VERIFY_OUTPUT_CAP = 4000;

/** The verify gate (S3): runs the profile's command in the workdir. */
export function makeVerifyGate(
  workdir: string,
  command: string,
  shell: ShellRunner = realShell,
): VerifyGatePort {
  return {
    run: async () => {
      const { exitCode, output } = await shell(command, workdir);
      if (exitCode === 0) return { green: true };
      const bounded =
        output.length > VERIFY_OUTPUT_CAP ? `…${output.slice(-VERIFY_OUTPUT_CAP)}` : output;
      return { green: false, output: bounded || "(no output)" };
    },
  };
}

/**
 * Build a callback that commits the cost-history file to the track branch.
 *
 * Sequence:
 *  1. Read the current file content (which includes the just-appended record).
 *  2. Reset the local workdir to `origin/<trackBranch>` (picks up the merged
 *     slice code without disturbing the history file we already read).
 *  3. Write the saved content back, stage it, and commit if changed.
 *  4. Push to origin so `flowd calibrate` can read it via `git show`.
 *
 * The returned function is injected into `CostMeterAdapter` and called after
 * every successful `appendCostRecord`.  Errors are propagated to the adapter
 * which swallows them (never halts the build).
 */
export function makeCommitHistoryToTrack(
  workdir: string,
  trackBranch: string,
  historyPath: string,
  actor: string,
  forgeToken: string,
): () => Promise<void> {
  return async () => {
    const absHistoryPath = resolve(workdir, historyPath);
    // git paths must use forward slashes even on Windows.
    const relHistoryPath = relative(workdir, absHistoryPath).replace(/\\/g, "/");

    // Step 1: Read content before the checkout resets it.
    const content = await readFile(absHistoryPath, "utf8").catch(() => "");
    if (content.trim().length === 0) return; // nothing to commit

    // Build an authenticated env so git's credential helper can use the
    // forge PAT (GH_TOKEN) for fetch and push — same injection as makeForgeRunner.
    const authedEnv = makeForgeRunner(forgeToken);

    // Step 2: Sync local workdir to the latest origin track branch.
    await authedEnv("git", ["-C", workdir, "fetch", "origin"]);
    await authedEnv("git", [
      "-C",
      workdir,
      "checkout",
      "-f",
      "-B",
      trackBranch,
      `origin/${trackBranch}`,
    ]);

    // Step 3: Write the updated history file and stage it.
    await mkdir(dirname(absHistoryPath), { recursive: true });
    await writeFile(absHistoryPath, content, "utf8");
    // Use -f (force) so the file is staged even when .flowd/ is listed in
    // .gitignore, which is the typical project layout.  Without -f, git silently
    // skips gitignored files and diff --cached returns 0 (nothing staged), so
    // the history file never reaches the track branch.
    await $`git -C ${workdir} add -f ${relHistoryPath}`.quiet();

    // Only commit when the file actually changed (idempotent guard).
    const diff = await $`git -C ${workdir} diff --cached --quiet`.nothrow().quiet();
    if (diff.exitCode === 0) return; // nothing staged

    const msg = "chore: update cost-history.jsonl";
    await $`git -C ${workdir} -c user.name=${actor} -c user.email=${actor}@flowd commit -m ${msg}`.quiet();

    // Step 4: Push via the forge-token-authenticated runner so the headless
    // flow-bot principal can write to origin without interactive credentials.
    await authedEnv("git", ["-C", workdir, "push", "origin", trackBranch]);
  };
}

/** Compose the real adapters into the engine's ports. */
export function buildPorts(
  config: FlowdConfig,
  credentials: CredentialStore,
  forgeToken: string,
): OrchestratorPorts {
  const tracker = new GitHubTrackerAdapter({
    repo: config.repo,
    trackBranch: config.trackBranch,
    run: makeForgeGhRunner(forgeToken),
  });
  const forge = new GitForgeAdapter({
    repo: config.repo,
    workdir: config.workdir,
    defaultBranch: config.defaultBranch,
    run: makeForgeRunner(forgeToken),
  });
  const implementer = new PiImplementer({
    repo: config.repo,
    workdir: config.workdir,
    trackBranch: config.trackBranch,
    verifyCommand: config.verifyCommand,
    model: config.models.implement,
    credentials,
  });
  const reviewer = new PiReviewer({
    repo: config.repo,
    workdir: config.workdir,
    model: config.models.review,
    credentials,
  });
  // reviewer ≠ implementer (invariant #2) and planReview ≠ slice (plan-gate
  // independence rule) — guaranteed by validateRoleModelConfig in parseConfig.
  const planReviewer = new PiPlanReviewer({
    repo: config.repo,
    workdir: config.workdir,
    model: config.models.planReview,
    credentials,
  });
  const agent: AgentPort = {
    implement: (ctx) => implementer.implement(ctx),
    review: (ctx) => reviewer.review(ctx),
    planReview: (trackId) => planReviewer.review(trackId),
  };
  const verify = makeVerifyGate(config.workdir, config.verifyCommand);
  const costMeter =
    config.costMeter !== undefined
      ? new CostMeterAdapter({
          config: config.costMeter,
          tracker,
          costEstimator: config.costEstimator,
          implementModelId: config.models.implement.id,
          reviewModelId: config.models.review.id,
          aiDisclaimer: config.aiDisclaimer,
          commitHistoryToTrack: makeCommitHistoryToTrack(
            config.workdir,
            config.trackBranch,
            config.costMeter.historyPath,
            config.actor,
            forgeToken,
          ),
        })
      : undefined;
  return { tracker, forge, agent, verify, costMeter };
}

/** Ensure the workdir is a clone of the repo (clone once, else fetch), with deps installed. */
export async function ensureWorkdir(repo: string, workdir: string): Promise<void> {
  if (existsSync(workdir)) {
    await $`git -C ${workdir} fetch origin`.quiet();
  } else {
    await $`gh repo clone ${repo} ${workdir}`.quiet();
  }
  // The verify gate (S3) runs in the workdir and typically needs installed
  // dependencies — e.g. `tsc` resolving package types. A fresh clone has none,
  // so without this the gate goes red on missing modules and every slice parks
  // (found dogfooding against pi-flow's real gate; the trivial sandbox gate
  // needed no deps). Bun-specific (the engine assumes Bun); fast no-op when
  // already current, and skipped for repos without a package.json.
  if (existsSync(`${workdir}/package.json`)) {
    await $`bun install`.cwd(workdir).quiet();
  }
}

/**
 * The agent's sandbox clone MUST live outside the repo flowd was launched in.
 * When it is nested inside (e.g. a relative `.flowd-workdir`), the coding
 * agent's tools can resolve paths up into the operator's real checkout and
 * write slice code there (a leak found dogfooding PRD-0003 that survived even
 * chdir-ing into the workdir). Refuse to run rather than risk the live tree.
 */
export function assertWorkdirIsolated(workdir: string, repoRoot: string): void {
  const w = resolve(workdir);
  const r = resolve(repoRoot);
  if (w === r || w.startsWith(r + sep)) {
    throw new Error(
      `workdir "${w}" is inside the repo "${r}". The agent sandbox must be OUTSIDE the operated repo — set config "workdir" to an absolute path elsewhere.`,
    );
  }
}

/**
 * Compute a track's pre-flight cost estimate from its slice set.
 * Returns undefined when costEstimator config is absent or the plan gate
 * has already been cleared (idempotent re-run).
 */
export function estimateFlowCost(
  slices: { effort?: Effort }[],
  config: CostEstimatorConfig,
): string {
  return estimateTrackCost(slices, config).formatted;
}

/**
 * Return the issue numbers of all open `tracking` parents in the repo.
 * Used by the daemon's all-tracks mode (PRD-0005 §3) to derive the cycle's
 * work list each iteration.
 */
export async function listTrackingParents(config: FlowdConfig): Promise<number[]> {
  const credentials = new FileCredentialStore(resolve(config.credentialsPath));
  const forgeToken = await readForgeToken(credentials);
  const tracker = new GitHubTrackerAdapter({
    repo: config.repo,
    trackBranch: config.trackBranch,
    run: makeForgeGhRunner(forgeToken),
  });
  return tracker.listByRole("tracking");
}

/** Drive one track's slice loop (S0–S8) to a fixpoint with the real adapters. */
export async function runFlow(config: FlowdConfig, trackId: number): Promise<RunResult> {
  // Use only credential-store keys, never ambient env (ADR-0029).
  scrubProviderEnvKeys();
  // Resolve ALL caller paths to absolute up front — against the process's
  // current cwd (the operator's repo), BEFORE the chdir below — so the
  // credential file still resolves there.
  const workdir = resolve(config.workdir);
  const credentials = new FileCredentialStore(resolve(config.credentialsPath));
  // Fail fast if the forge PAT is absent — never fall back to ambient auth.
  const forgeToken = await readForgeToken(credentials);
  // Fail fast if the sandbox is nested in the operator's repo (leak guard).
  assertWorkdirIsolated(workdir, process.cwd());
  const resolved: FlowdConfig = { ...config, workdir };
  await ensureWorkdir(resolved.repo, workdir);
  const ports = buildPorts(resolved, credentials, forgeToken);

  const opts = {
    reviewerIterationCap: config.reviewerIterationCap,
    actor: config.actor,
    aiDisclaimer: config.aiDisclaimer,
  };

  // T13/T14 — plan-review gate. Run before the slice loop; the cost
  // estimator (slice 6) computes a pre-flight estimate posted at clearance.
  const costEstimate =
    config.costEstimator &&
    estimateFlowCost(await ports.tracker.listSlices(trackId), config.costEstimator);
  const gate = await runPlanGate(ports, trackId, opts, costEstimate ?? undefined);
  if (gate.kind === "escalate") {
    return {
      steps: [],
      outcome: "parked",
      parkedReason: gate.risks.join("; "),
    };
  }

  // Confine the run to the sandbox clone: make the workdir the process cwd for
  // the agent loop. The agent's coding tools are cwd-bound, but anything that
  // falls back to `process.cwd()` (a shell side-effect, a stray relative path)
  // must land in the disposable workdir — NEVER the operator's real checkout
  // (dogfooding PRD-0003 leaked slice code into the live repo). flowd's own
  // git/gh/verify calls are already absolute (`git -C`, `--repo`, gate cwd), so
  // they are unaffected. Restored in `finally` (single-threaded, PRD scope).
  const originalCwd = process.cwd();
  process.chdir(workdir);
  try {
    return await runTrack(ports, trackId, opts);
  } finally {
    process.chdir(originalCwd);
  }
}
