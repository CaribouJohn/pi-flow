import { existsSync } from "node:fs";
import {
  type AgentPort,
  type OrchestratorPorts,
  type RunResult,
  type VerifyGatePort,
  runTrack,
} from "@pi-flow/flow-engine";
import { $ } from "bun";
import type { FlowdConfig } from "./config.ts";
import { type CredentialStore, FileCredentialStore } from "./credentials.ts";
import { scrubProviderEnvKeys } from "./env-scrub.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";
import { PiImplementer } from "./pi-implementer.ts";
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
    model: config.models.implement,
    credentials,
  });
  const reviewer = new PiReviewer({
    repo: config.repo,
    workdir: config.workdir,
    model: config.models.review,
    credentials,
  });
  // reviewer ≠ implementer: distinct sessions (per call) on distinct models
  // (config.models, validated different in parseConfig — invariant #2).
  const agent: AgentPort = {
    implement: (ctx) => implementer.implement(ctx),
    review: (ctx) => reviewer.review(ctx),
  };
  const verify = makeVerifyGate(config.workdir, config.verifyCommand);
  return { tracker, forge, agent, verify };
}

/** Ensure the workdir is a clone of the repo (clone once, else fetch). */
async function ensureWorkdir(repo: string, workdir: string): Promise<void> {
  if (existsSync(workdir)) {
    await $`git -C ${workdir} fetch origin`.quiet();
  } else {
    await $`gh repo clone ${repo} ${workdir}`.quiet();
  }
}

/** Drive one track's slice loop (S0–S8) to a fixpoint with the real adapters. */
export async function runFlow(config: FlowdConfig, trackId: number): Promise<RunResult> {
  // Use only credential-store keys, never ambient env (ADR-0029).
  scrubProviderEnvKeys();
  const credentials = new FileCredentialStore(config.credentialsPath);
  await ensureWorkdir(config.repo, config.workdir);
  const ports = buildPorts(config, credentials);
  return runTrack(ports, trackId, {
    reviewerIterationCap: config.reviewerIterationCap,
    actor: config.actor,
    aiDisclaimer: config.aiDisclaimer,
  });
}
