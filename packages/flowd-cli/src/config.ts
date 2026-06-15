import { readFile } from "node:fs/promises";
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
  };
  // Fail fast on a same-model pair (invariant #2) before any work runs.
  validateRoleModelConfig(config.models);
  return config;
}

function parseModels(input: unknown): RoleModelConfig {
  if (typeof input !== "object" || input === null) {
    throw new Error(
      "flowd config.models must be an object with implement, review, slice, planReview",
    );
  }
  const m = input as Record<string, unknown>;
  return {
    implement: parseModel(m.implement, "implement"),
    review: parseModel(m.review, "review"),
    slice: parseModel(m.slice, "slice"),
    planReview: parseModel(m.planReview, "planReview"),
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

function int(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`flowd config: "${key}" must be a positive integer`);
  }
  return v;
}
