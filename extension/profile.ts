/**
 * Profile reader — parses `.pi/flow.profile.md` into a typed shape.
 *
 * Frontmatter (YAML between `---` lines) is the machine-readable contract;
 * the markdown body below it is the LLM-facing prose. We return both.
 *
 * Shape mirrors the schema documented in `.pi/flow.profile.md` and
 * DESIGN.md §Config. Any new fields added there must be added here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type StateLabels = {
  needs_triage: string;
  needs_info: string;
  needs_grilling: string;
  needs_slicing: string;
  needs_plan_review: string;
  tracking: string;
  ready_for_agent: string;
  ready_for_human: string;
  needs_acceptance: string;
  wontfix: string;
};

export type Profile = {
  tracker: "github";
  repo: string;
  default_branch: string;
  track_branch_prefix: string;
  verify_gate: string;
  in_situ_harness: string;
  reviewer_command: string;
  reviewer_iteration_cap: number;
  poll_cadence_seconds: number;
  ai_disclaimer: string;
  labels: {
    category: string[];
    state: StateLabels;
    effort: { low: string; medium: string; high: string };
    review: { agent: string; human: string };
  };
  body: string;
};

export class ProfileError extends Error {
  constructor(message: string, public profilePath: string) {
    super(`${message} (file: ${profilePath})`);
    this.name = "ProfileError";
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const REQUIRED_TOP_LEVEL = [
  "tracker",
  "repo",
  "default_branch",
  "track_branch_prefix",
  "verify_gate",
  "reviewer_command",
  "reviewer_iteration_cap",
  "poll_cadence_seconds",
  "ai_disclaimer",
  "labels",
] as const;

const REQUIRED_STATE_KEYS: Array<keyof StateLabels> = [
  "needs_triage",
  "needs_info",
  "needs_grilling",
  "needs_slicing",
  "needs_plan_review",
  "tracking",
  "ready_for_agent",
  "ready_for_human",
  "needs_acceptance",
  "wontfix",
];

/**
 * Resolve the profile path under a given working directory.
 * Exposed so callers can include the path in their own error messages.
 */
export function profilePathFor(cwd: string): string {
  return join(cwd, ".pi", "flow.profile.md");
}

/**
 * Read and parse the profile. Throws `ProfileError` with an actionable
 * message on any failure (file missing, frontmatter missing/invalid,
 * required field absent, label group malformed).
 */
export function readProfile(cwd: string): Profile {
  const path = profilePathFor(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProfileError(`Could not read profile: ${msg}`, path);
  }

  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new ProfileError(
      "Profile is missing a YAML frontmatter block (expected `---` ... `---` at the top)",
      path,
    );
  }

  let fm: unknown;
  try {
    fm = parseYaml(m[1] ?? "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProfileError(`Frontmatter is not valid YAML: ${msg}`, path);
  }

  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    throw new ProfileError(
      `Frontmatter must be a YAML mapping (got ${Array.isArray(fm) ? "array" : typeof fm})`,
      path,
    );
  }
  const f = fm as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in f)) {
      throw new ProfileError(`Frontmatter is missing required field: ${key}`, path);
    }
  }

  const labels = f.labels as Record<string, unknown> | undefined;
  if (!labels || typeof labels !== "object") {
    throw new ProfileError("Frontmatter `labels` must be a mapping", path);
  }
  for (const group of ["category", "state", "effort", "review"] as const) {
    if (!(group in labels)) {
      throw new ProfileError(`labels.${group} is required`, path);
    }
  }

  const state = labels.state as Record<string, unknown>;
  for (const k of REQUIRED_STATE_KEYS) {
    if (typeof state[k] !== "string" || state[k] === "") {
      throw new ProfileError(`labels.state.${k} must be a non-empty string`, path);
    }
  }

  return {
    ...(f as unknown as Omit<Profile, "body">),
    body: m[2] ?? "",
  };
}
