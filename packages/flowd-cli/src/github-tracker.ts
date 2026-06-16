import type {
  CreateItemParams,
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
  title: string;
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
    const role = await this.getParentRole(trackId);
    return { id: trackId, branch: this.trackBranch, role };
  }

  /** Read the parent issue's role label. */
  private async getParentRole(trackId: number): Promise<Role> {
    const out = await this.run([
      "issue",
      "view",
      String(trackId),
      "--repo",
      this.repo,
      "--json",
      "labels",
    ]);
    const labels = (JSON.parse(out) as { labels: { name: string }[] }).labels.map((l) => l.name);
    return parseRole(labels) ?? "needs-triage";
  }

  async listByRole(role: Role): Promise<number[]> {
    const out = await this.run([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--label",
      role,
      "--json",
      "number",
    ]);
    const issues = JSON.parse(out) as { number: number }[];
    return issues.map((i) => i.number);
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
      "number,title,body,labels,assignees,state",
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

  async createItem(params: CreateItemParams): Promise<number> {
    // Labels: role + category + (effort) + review — the profile's 1:1 strings.
    const labels: string[] = [params.role, params.category];
    if (params.effort) labels.push(`effort:${params.effort}`);
    labels.push(`review:${params.review}`);
    const args = [
      "issue",
      "create",
      "--repo",
      this.repo,
      "--title",
      params.title,
      "--body",
      params.body,
    ];
    for (const label of labels) {
      args.push("--label", label);
    }
    return parseIssueNumber(await this.run(args));
  }

  async setDependencies(itemId: number, dependsOn: number[]): Promise<void> {
    if (dependsOn.length === 0) return; // nothing to write
    // Append a `## Blocked by` section to the body (the form parseDependsOn reads).
    const body = (await this.getItemBody(itemId)).trim();
    const section = ["## Blocked by", ...dependsOn.map((n) => `- #${n}`)].join("\n");
    const newBody = body.length > 0 ? `${body}\n\n${section}\n` : `${section}\n`;
    await this.run(["issue", "edit", String(itemId), "--repo", this.repo, "--body", newBody]);
  }

  async getItemBody(itemId: number): Promise<string> {
    const out = await this.run([
      "issue",
      "view",
      String(itemId),
      "--repo",
      this.repo,
      "--json",
      "body",
    ]);
    return (JSON.parse(out) as { body: string | null }).body ?? "";
  }

  async setRole(itemId: number, role: Role): Promise<void> {
    // Remove all existing role labels, then add the target. A remove can fail
    // simply because the label isn't present (expected) — but it can also fail
    // on a real error (network/auth), which combined with a succeeding add
    // would leave a corrupted multi-role state. Don't swallow silently: log so
    // the failure is visible rather than producing a silent inconsistency.
    for (const r of ROLE_LABELS) {
      await this.run([
        "issue",
        "edit",
        String(itemId),
        "--repo",
        this.repo,
        "--remove-label",
        r,
      ]).catch((err) => {
        console.warn(
          `[github-tracker] setRole: removing label "${r}" from #${itemId} failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    await this.run(["issue", "edit", String(itemId), "--repo", this.repo, "--add-label", role]);
  }
}

// --- pure parsers (unit-tested directly) ---

/** Parse the issue number from `gh issue create` output (the trailing issue URL). */
export function parseIssueNumber(ghCreateOutput: string): number {
  const n = Number(ghCreateOutput.trim().split("/").pop());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`could not parse issue number from: ${ghCreateOutput.trim()}`);
  }
  return n;
}

function mapIssueToSlice(issue: GhIssue): TrackerSlice | null {
  const labels = issue.labels.map((l) => l.name);
  const role = parseRole(labels);
  if (role === undefined) return null;
  return {
    id: issue.number,
    title: issue.title,
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
