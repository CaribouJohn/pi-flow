import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type OrchestratorPorts,
  type SlicePlan,
  type VerifyGatePort,
  runPlanGate,
  writeSlicePlan,
} from "@pi-flow/flow-engine";
import type { FlowdConfig } from "./config.ts";
import { type CostEstimatorConfig, estimateTrackCost } from "./cost-estimator.ts";
import { type CredentialStore, FileCredentialStore } from "./credentials.ts";
import { scrubProviderEnvKeys } from "./env-scrub.ts";
import { assertWorkdirIsolated, ensureWorkdir } from "./flow-run.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";
import { PiPlanReviewer } from "./pi-plan-reviewer.ts";
import { PiSlicer } from "./pi-slicer.ts";

/**
 * Compute a track's pre-flight cost estimate from its slice set.
 * Returns undefined when costEstimator config is absent.
 */
export function planCostEstimate(
  slices: { effort?: "low" | "medium" | "high" }[],
  config: CostEstimatorConfig,
): string {
  return estimateTrackCost(slices, config).formatted;
}

/** Compose the plan adapters (slicer + plan-reviewer + verify gate). */
export function buildPlanPorts(
  config: FlowdConfig,
  credentials: CredentialStore,
): OrchestratorPorts {
  const tracker = new GitHubTrackerAdapter({ repo: config.repo, trackBranch: config.trackBranch });
  const forge = new GitForgeAdapter({
    repo: config.repo,
    workdir: config.workdir,
    defaultBranch: config.defaultBranch,
  });
  const planReviewer = new PiPlanReviewer({
    repo: config.repo,
    workdir: config.workdir,
    model: config.models.planReview,
    credentials,
  });
  const agent = {
    implement: async () => {
      throw new Error("implement not available in plan mode");
    },
    review: async () => {
      throw new Error("review not available in plan mode");
    },
    planReview: (trackId: number) => planReviewer.review(trackId),
  };
  const verify: VerifyGatePort = {
    run: async () => ({ green: true }),
  };
  return { tracker, forge, agent, verify };
}

export interface PlanFlowInput {
  /** The parent issue number (must be in `needs-slicing`). */
  issue: number;
  /** Path to the PRD file on disk (relative or absolute). */
  prdPath: string;
  config: FlowdConfig;
}

export interface PlanFlowOutput {
  /** The created (or deduped) child slice issue numbers, in plan order. */
  childIds: number[];
  /** The acceptance item's issue number, or undefined when none exists. */
  acceptanceId: number | undefined;
  /** The plan gate result. */
  gate: "clear" | "escalate";
  /** Named risks (non-empty only for escalate). */
  risks: string[];
  /** Cost estimate string (posted at clearance). */
  costEstimate?: string;
}

/**
 * Run the `flowd plan` pipeline: T12 (slice) → T13/T14 (plan-review).
 *
 * Steps:
 *  1. Read the parent issue — must be `needs-slicing`.
 *  2. Read the PRD file from disk.
 *  3. Run the slice agent (PiSlicer) to produce a SlicePlan.
 *  4. Write the plan (writeSlicePlan) — creates child Items + acceptance Item,
 *     advances parent → `needs-plan-review`.
 *  5. Run the plan-review gate (runPlanGate) — on clear, create the track
 *     branch, compute + post the cost estimate; on escalate, post the named
 *     risks and stop.
 *
 * Idempotency: re-running at any reached state is a no-op (parent-role gate +
 * per-child dedup + marker comments — SPEC §8.8).
 */
export async function runPlan(input: PlanFlowInput): Promise<PlanFlowOutput> {
  // Use only credential-store keys, never ambient env (ADR-0029).
  scrubProviderEnvKeys();

  const workdir = resolve(input.config.workdir);
  const credentialsPath = resolve(input.config.credentialsPath);
  const prdPath = resolve(input.prdPath);
  // Resolve the config so adapters receive absolute paths — relative workdir
  // breaks git -C operations inside GitForgeAdapter (same as runFlow).
  const config: FlowdConfig = { ...input.config, workdir, credentialsPath };

  if (!existsSync(prdPath)) {
    throw new Error(`PRD file not found: ${prdPath}`);
  }

  const prd = await readFile(prdPath, "utf8");
  if (prd.trim().length === 0) {
    throw new Error(`PRD file is empty: ${prdPath}`);
  }

  const credentials = new FileCredentialStore(credentialsPath);
  const ports = buildPlanPorts(config, credentials);

  // Fail fast if the sandbox is nested in the operator's repo (leak guard).
  assertWorkdirIsolated(workdir, process.cwd());
  // Ensure the workdir is a fresh clone of the repo (clone once, else fetch).
  await ensureWorkdir(config.repo, workdir);

  // ── T12: Slice ───────────────────────────────────────────────────────────
  const slicer = new PiSlicer({
    workdir,
    model: config.models.slice,
    credentials,
  });

  console.error(`Slicing issue #${input.issue} from PRD ${prdPath}...`);
  const plan = await slicer.slice(prd);

  return runPlanPipeline(ports, config, { issue: input.issue, prd, plan });
}

/**
 * Core plan pipeline (after file loading, credential setup, and agent slicing).
 * Extracted from `runPlan` so it can be unit-tested with faked ports and a
 * canned slice plan — the LLM-dependent slicer is factored out of scope.
 */
export async function runPlanPipeline(
  ports: OrchestratorPorts,
  config: FlowdConfig,
  input: { issue: number; prd: string; plan: SlicePlan },
): Promise<PlanFlowOutput> {
  const opts = {
    reviewerIterationCap: config.reviewerIterationCap,
    actor: config.actor,
    aiDisclaimer: config.aiDisclaimer,
  };

  // writeSlicePlan validates + writes children + acceptance via tracker port.
  const sliceResult = await writeSlicePlan(ports, input.issue, input.plan, opts);
  console.error(
    `Created ${sliceResult.childIds.length} slice(s) and acceptance #${sliceResult.acceptanceId ?? "?"}.`,
  );

  // ── T13/T14: Plan review gate ────────────────────────────────────────────
  // Compute the cost estimate from the child slices (their effort levels).
  const trackerSlices = await ports.tracker.listSlices(input.issue);
  const childSlices = trackerSlices.filter((s) => s.role !== "needs-acceptance" && !s.closed);
  const costEstimate = config.costEstimator && planCostEstimate(childSlices, config.costEstimator);

  const gate = await runPlanGate(ports, input.issue, opts, costEstimate ?? undefined);

  if (gate.kind === "escalate") {
    console.error(`Plan gate escalated: ${gate.risks.join("; ")}`);
    return {
      childIds: sliceResult.childIds,
      acceptanceId: sliceResult.acceptanceId,
      gate: "escalate",
      risks: gate.risks,
    };
  }

  console.error("Plan gate cleared. Track branch created.");
  return {
    childIds: sliceResult.childIds,
    acceptanceId: sliceResult.acceptanceId,
    gate: "clear",
    risks: [],
    costEstimate: gate.costEstimate,
  };
}
