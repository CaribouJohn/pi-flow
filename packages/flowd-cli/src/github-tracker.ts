import type {
  Effort,
  ReviewPolicy,
  Role,
  Track,
  TrackerPort,
  TrackerSlice,
} from "@pi-flow/flow-engine";
import { $ } from "bun";

/**
 * A `gh`-backed {@link TrackerPort}. Implements the engine's tracker contract
 * over the GitHub CLI. The pure mapping/parsing functions are exported and
 * unit-tested directly; the CLI calls are behind an injectable {@link GhRunner}
 * so the adapter is testable without the network.
 *
 * Profile note: this repo maps each canonical role 1:1 to a label string, so
 * the role label *is* the canonical name.
 */

/** Runs `gh` with the given args and returns stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

const realGhRunner: GhRunner = async (args) => await $`gh ${args}`.text();

const ROLE_LABELS: readonly Role[] = [
  "needs-triage",
  "needs-info",
  "needs-grilling",
  "needs-slicing",
  "needs-plan-review",
  "tracking",
  "ready-for-agent",
  "ready-for-human",
  "needs-acceptance",
  "wontfix",
];

interface GhIssue {
  number: number;
  body: string | null;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
}

export interface GitHubTrackerOptions {
  repo: string;
  /** The track branch (a git concept the tracker can't derive; supplied here). */
  trackBranch: string;
  run?: GhRunner;
}

export class GitHubTrackerAdapter implements TrackerPort {
  private readonly repo: string;
  private readonly trackBranch: string;
  private readonly run: GhRunner;

  constructor(opts: GitHubTrackerOptions) {
    this.repo = opts.repo;
    this.trackBranch = opts.trackBranch;
    this.run = opts.run ?? realGhRunner;
  }

  async getTrack(trackId: number): Promise<Track> {
    return { id: trackId, branch: this.trackBranch };
  }

  async listSlices(trackId: number): Promise<TrackerSlice[]> {
    const out = await this.run([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      "number,body,labels,assignees,state",
    ]);
    const issues = JSON.parse(out) as GhIssue[];
    const slices: TrackerSlice[] = [];
    for (const issue of issues) {
      if (parseParent(issue.body ?? "") !== trackId) continue;
      const slice = mapIssueToSlice(issue);
      if (slice !== null) slices.push(slice);
    }
    return slices;
  }

  async setAssignee(sliceId: number, who: string): Promise<void> {
    await this.run(["issue", "edit", String(sliceId), "--repo", this.repo, "--add-assignee", who]);
  }

  async closeSlice(sliceId: number): Promise<void> {
    await this.run(["issue", "close", String(sliceId), "--repo", this.repo]);
  }

  async comment(itemId: number, body: string): Promise<void> {
    await this.run(["issue", "comment", String(itemId), "--repo", this.repo, "--body", body]);
  }
}

// --- pure parsers (unit-tested directly) ---

function mapIssueToSlice(issue: GhIssue): TrackerSlice | null {
  const labels = issue.labels.map((l) => l.name);
  const role = parseRole(labels);
  if (role === undefined) return null;
  return {
    id: issue.number,
    role,
    effort: parseEffort(labels),
    review: parseReview(labels),
    dependsOn: parseDependsOn(issue.body ?? ""),
    assignee: issue.assignees[0]?.login ?? null,
    closed: issue.state.toUpperCase() === "CLOSED",
  };
}

export function parseRole(labels: string[]): Role | undefined {
  return ROLE_LABELS.find((r) => labels.includes(r));
}

export function parseEffort(labels: string[]): Effort | undefined {
  for (const e of ["low", "medium", "high"] as const) {
    if (labels.includes(`effort:${e}`)) return e;
  }
  return undefined;
}

export function parseReview(labels: string[]): ReviewPolicy {
  return labels.includes("review:human") ? "human" : "agent";
}

/**
 * Issue numbers from the dependency section ONLY (SPEC §4): a `Depends on: #n`
 * line, or refs under a `## Blocked by` heading. Refs elsewhere (parent links,
 * prose) do not count.
 */
export function parseDependsOn(body: string): number[] {
  const refs = new Set<number>();
  let inBlockedBy = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading !== null) {
      inBlockedBy = /^blocked by\b/i.test((heading[1] ?? "").trim());
      continue;
    }
    if (/depends on:/i.test(line) || inBlockedBy) {
      for (const n of extractIssueRefs(line)) refs.add(n);
    }
  }
  return [...refs];
}

/** The parent issue number from a `## Parent` heading or a `Parent: #n` line. */
export function parseParent(body: string): number | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s+parent\b/i.test(line) || /^parent:/i.test(line.trim())) {
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const refs = extractIssueRefs(lines[j] ?? "");
        if (refs.length > 0) return refs[0];
      }
    }
  }
  return undefined;
}

function extractIssueRefs(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}
