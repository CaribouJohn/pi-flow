import { readFile } from "node:fs/promises";
import type { CostEstimatorConfig } from "./cost-estimator.ts";
import { type RoleModelConfig, validateRoleModelConfig } from "./model-config.ts";

/**
 * Runtime configuration for `flowd run`. Everything repo/deployment-specific the
 * engine refuses to hard-code (SPEC §6), in one file. The model pair is
 * validated here so a same-model misconfiguration fails before any work runs.
 */
export interface FlowdConfig {
  repo: string;
  defaultBranch: string;
  trackBranch: string;
  /** Local clone of `repo` where git ops, the agents, and verify run. */
  workdir: string;
  /** The identity autonomous writes claim/attribute to (the assignee = the lock). */
  actor: string;
  aiDisclaimer: string;
  reviewerIterationCap: number;
  /** The deterministic verify gate, run in the workdir (S3). */
  verifyCommand: string;
  /** Path to the credential store JSON (provider → API key). */
  credentialsPath: string;
  models: RoleModelConfig;
  /** All values are PROVISIONAL v1 guesses — calibration is PRD-0004.
   *  Optional: if absent, cost estimation is skipped. */
  costEstimator?: CostEstimatorConfig;
}

export async function loadConfig(path: string): Promise<FlowdConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`could not read flowd config at ${path}: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`flowd config at ${path} is not valid JSON`);
  }
  return parseConfig(parsed);
}

export function parseConfig(input: unknown): FlowdConfig {
  if (typeof input !== "object" || input === null) {
    throw new Error("flowd config must be an object");
  }
  const o = input as Record<string, unknown>;
  const config: FlowdConfig = {
    repo: str(o, "repo"),
    defaultBranch: str(o, "defaultBranch"),
    trackBranch: str(o, "trackBranch"),
    workdir: str(o, "workdir"),
    actor: str(o, "actor"),
    aiDisclaimer: str(o, "aiDisclaimer"),
    reviewerIterationCap: int(o, "reviewerIterationCap"),
    verifyCommand: str(o, "verifyCommand"),
    credentialsPath: str(o, "credentialsPath"),
    models: parseModels(o.models),
    costEstimator: parseCostEstimator(o.costEstimator),
  };
  // Fail fast on a same-model pair (invariant #2) before any work runs.
  validateRoleModelConfig(config.models);
  // Validate cost estimator tables are complete (fail-fast misconfiguration).
  // Only validates when present — cost estimation is skipped when absent.
  if (config.costEstimator) {
    validateCostEstimatorConfig(config.costEstimator);
  }
  return config;
}

function parseModels(input: unknown): RoleModelConfig {
  if (typeof input !== "object" || input === null) {
    throw new Error("flowd config.models must be an object with implement + review");
  }
  const m = input as Record<string, unknown>;
  return {
    implement: parseModel(m.implement, "implement"),
    review: parseModel(m.review, "review"),
  };
}

function parseModel(input: unknown, role: string): { provider: string; id: string } {
  if (typeof input !== "object" || input === null) {
    throw new Error(`flowd config.models.${role} must be { provider, id }`);
  }
  const m = input as Record<string, unknown>;
  return { provider: str(m, "provider"), id: str(m, "id") };
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`flowd config: "${key}" must be a non-empty string`);
  }
  return v;
}

export function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`flowd config: "${key}" must be a positive number`);
  }
  return v;
}

function int(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`flowd config: "${key}" must be a positive integer`);
  }
  return v;
}

// ── Cost estimator config parsing ──────────────────────────────────────────

function parseCostEstimator(input: unknown): CostEstimatorConfig | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) {
    throw new Error(
      "flowd config.costEstimator must be an object with reworkMultiplier, effortTokens, modelPrices, effortToModel",
    );
  }
  const ce = input as Record<string, unknown>;
  return {
    reworkMultiplier: num(ce, "reworkMultiplier"),
    effortTokens: parseEffortTokens(ce.effortTokens),
    modelPrices: parseModelPrices(ce.modelPrices),
    effortToModel: parseEffortToModel(ce.effortToModel),
  };
}

function parseEffortTokens(input: unknown): CostEstimatorConfig["effortTokens"] {
  if (typeof input !== "object" || input === null) {
    throw new Error(
      "flowd config.costEstimator.effortTokens must be an object with low, medium, high",
    );
  }
  const et = input as Record<string, unknown>;
  const efforts = ["low", "medium", "high"] as const;
  const result: Record<string, { implement: number; review: number }> = {};
  for (const effort of efforts) {
    const entry = et[effort];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `flowd config.costEstimator.effortTokens.${effort} must be { implement, review }`,
      );
    }
    const e = entry as Record<string, unknown>;
    result[effort] = {
      implement: int(e, "implement"),
      review: int(e, "review"),
    };
  }
  return result as CostEstimatorConfig["effortTokens"];
}

function parseModelPrices(input: unknown): CostEstimatorConfig["modelPrices"] {
  if (typeof input !== "object" || input === null) {
    throw new Error(
      "flowd config.costEstimator.modelPrices must be an object mapping tier names to prices",
    );
  }
  const mp = input as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(mp)) {
    if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
      throw new Error(`flowd config.costEstimator.modelPrices["${key}"] must be a positive number`);
    }
    result[key] = val;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("flowd config.costEstimator.modelPrices must have at least one entry");
  }
  return result;
}

function parseEffortToModel(input: unknown): CostEstimatorConfig["effortToModel"] {
  if (typeof input !== "object" || input === null) {
    throw new Error(
      "flowd config.costEstimator.effortToModel must be an object with low, medium, high",
    );
  }
  const em = input as Record<string, unknown>;
  const efforts = ["low", "medium", "high"] as const;
  const result: Record<string, { implement: string; review: string }> = {};
  for (const effort of efforts) {
    const entry = em[effort];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `flowd config.costEstimator.effortToModel.${effort} must be { implement, review }`,
      );
    }
    const e = entry as Record<string, unknown>;
    result[effort] = {
      implement: str(e, "implement"),
      review: str(e, "review"),
    };
  }
  return result as CostEstimatorConfig["effortToModel"];
}

/**
 * Validate that every model tier referenced by `effortToModel` exists in
 * `modelPrices` and that every effort level in `effortToModel` exists in
 * `effortTokens`. Fail-fast on misconfiguration.
 */
export function validateCostEstimatorConfig(ce: CostEstimatorConfig): void {
  const efforts = ["low", "medium", "high"] as const;
  for (const effort of efforts) {
    const routing = ce.effortToModel[effort];
    if (!routing) {
      throw new Error(
        `flowd config.costEstimator.effortToModel missing required effort "${effort}"`,
      );
    }
    if (ce.modelPrices[routing.implement] === undefined) {
      throw new Error(
        `flowd config.costEstimator.modelPrices missing tier "${routing.implement}" (referenced by effortToModel.${effort}.implement)`,
      );
    }
    if (ce.modelPrices[routing.review] === undefined) {
      throw new Error(
        `flowd config.costEstimator.modelPrices missing tier "${routing.review}" (referenced by effortToModel.${effort}.review)`,
      );
    }
    if (!ce.effortTokens[effort]) {
      throw new Error(
        `flowd config.costEstimator.effortTokens missing required effort "${effort}"`,
      );
    }
  }
}
