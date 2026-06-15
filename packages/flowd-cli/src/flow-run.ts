import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
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
import { type CredentialStore, FileCredentialStore } from "./credentials.ts";
import { scrubProviderEnvKeys } from "./env-scrub.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";
import { PiImplementer } from "./pi-implementer.ts";
import { PiPlanReviewer } from "./pi-plan-reviewer.ts";
import { PiReviewer } from "./pi-reviewer.ts";

/** Runs a shell command in `cwd` and returns its exit code. */
export type ShellRunner = (command: string, cwd: string) => Promise<number>;

const realShell: ShellRunner = async (command, cwd) => {
  const res = await $`sh -c ${command}`.cwd(cwd).nothrow().quiet();
  return res.exitCode;
};

/** The verify gate (S3): runs the profile's command in the workdir. */
export function makeVerifyGate(
  workdir: string,
  command: string,
  shell: ShellRunner = realShell,
): VerifyGatePort {
  return { run: async () => ({ green: (await shell(command, workdir)) === 0 }) };
}

/** Compose the real adapters into the engine's ports. */
export function buildPorts(config: FlowdConfig, credentials: CredentialStore): OrchestratorPorts {
  const tracker = new GitHubTrackerAdapter({ repo: config.repo, trackBranch: config.trackBranch });
  const forge = new GitForgeAdapter({
    repo: config.repo,
    workdir: config.workdir,
    defaultBranch: config.defaultBranch,
  });
  const implementer = new PiImplementer({
    repo: config.repo,
    workdir: config.workdir,
    trackBranch: config.trackBranch,
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
  return { tracker, forge, agent, verify };
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

/** Drive one track's slice loop (S0–S8) to a fixpoint with the real adapters. */
export async function runFlow(config: FlowdConfig, trackId: number): Promise<RunResult> {
  // Use only credential-store keys, never ambient env (ADR-0029).
  scrubProviderEnvKeys();
  // Resolve ALL caller paths to absolute up front — against the process's
  // current cwd (the operator's repo), BEFORE the chdir below — so the
  // credential file still resolves there.
  const workdir = resolve(config.workdir);
  const credentials = new FileCredentialStore(resolve(config.credentialsPath));
  // Fail fast if the sandbox is nested in the operator's repo (leak guard).
  assertWorkdirIsolated(workdir, process.cwd());
  const resolved: FlowdConfig = { ...config, workdir };
  await ensureWorkdir(resolved.repo, workdir);
  const ports = buildPorts(resolved, credentials);

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
