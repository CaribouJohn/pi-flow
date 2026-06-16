/**
 * The adapter ports the orchestrator drives. The engine depends only on these
 * interfaces; real adapters (GitHub `gh`, git/forge, `pi-coding-agent`) and the
 * in-memory test fakes implement them. Keeping the engine behind ports is what
 * lets it stay framework-free (ADR-0016) and unit-testable (SPEC §8.9).
 */
import type {
  Category,
  Effort,
  MainProtection,
  PlanReviewVerdict,
  PullRequest,
  ReviewPolicy,
  Role,
  SliceCost,
  Track,
  TrackerSlice,
  Verdict,
} from "./domain.ts";

/** Tracker CRUD + dependency parsing (SPEC §6.1). Returns tracker-owned fields. */
export interface TrackerPort {
  getTrack(trackId: number): Promise<Track>;
  listSlices(trackId: number): Promise<TrackerSlice[]>;
  /** Claim a slice — the in-progress lock (S1). */
  setAssignee(sliceId: number, who: string): Promise<void>;
  closeSlice(sliceId: number): Promise<void>;
  /** Post a comment (carrying the profile's AI disclaimer). */
  comment(itemId: number, body: string): Promise<void>;
  /** Set the role/label on an item (for plan-gate advance, T13). */
  setRole(itemId: number, role: Role): Promise<void>;
  /** Create a child item under a parent. Returns the new item's id. */
  createItem(params: CreateItemParams): Promise<number>;
  /** Write the `## Blocked by` dependency section into an item's body. */
  setDependencies(itemId: number, dependsOn: number[]): Promise<void>;
  /** Read an item's body text (for stable-identity dedup). */
  getItemBody(itemId: number): Promise<string>;
}

/** Parameters for `createItem` — the fields the writer sets on a new child. */
export interface CreateItemParams {
  parentId: number;
  role: Role;
  title: string;
  body: string;
  effort?: Effort;
  review: ReviewPolicy;
  category: Category;
}

/** Git/forge ops, scoped so the engine can never merge `main` (invariant #1, #6). */
export interface ForgePort {
  /** S0 — merge the default branch into the track branch (merge, not rebase). */
  driftRefresh(trackBranch: string): Promise<void>;
  getSliceBranch(sliceId: number): Promise<string | null>;
  getSlicePr(sliceId: number): Promise<PullRequest | null>;
  /** Create the slice branch off the track branch (S2). */
  createSliceBranch(sliceId: number, fromBranch: string): Promise<string>;
  /** Open the slice PR with base = the track branch (S5). */
  openPr(sliceId: number, base: string): Promise<PullRequest>;
  /**
   * Push the slice branch's latest commits to origin (S6a). The implementer
   * commits a re-implementation locally; without publishing it the PR diff (and
   * thus the reviewer) keeps seeing the original code, so the agent can never
   * satisfy the reviewer. Called before reopenForReview.
   */
  pushSlice(sliceId: number): Promise<void>;
  /** Record a review outcome: set status + increment reviewAttempts (S6). */
  recordReviewVerdict(prNumber: number, verdict: Verdict): Promise<void>;
  /** Re-open a changes-requested PR for re-review after a fix (S6a). */
  reopenForReview(prNumber: number): Promise<void>;
  /**
   * Bring the slice branch up to date with the track branch before merging (S7).
   * Sibling slices may have merged into the track during this same run, leaving
   * this slice stale → an un-creatable merge commit. Merges the track into the
   * slice and pushes. Returns `false` if the merge conflicts (left clean via
   * abort) — the slice then parks for manual resolution rather than crashing.
   */
  refreshSliceFromTrack(sliceId: number, trackBranch: string): Promise<boolean>;
  /** Merge the slice PR into its base (the track branch only) (S7). */
  mergePr(prNumber: number): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /**
   * Create the track branch off `main` (T13). Idempotent: skip if the
   * branch already exists so a re-run is a no-op (SPEC §8.8).
   */
  createTrackBranch(branch: string): Promise<void>;
  /**
   * Read the default branch's merge-protection state (ADR-0038 precondition).
   * Returns `{ requiresPr: false, requiresNonAuthorApproval: false }` when the
   * branch has no protection rule (personal/sandbox repos). Never throws.
   */
  getMainProtection(): Promise<MainProtection>;
  /**
   * Look up the open track→main PR by head branch (A1 idempotent re-run).
   * Returns null when no open PR exists with that head.
   */
  getTrackPr(headBranch: string): Promise<PullRequest | null>;
  /**
   * Open the track→main PR (A1). The base is always the default branch.
   * The engine never merges this PR — parking for the human is invariant #1.
   */
  openTrackPr(params: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  /**
   * Replace the body of an existing PR (A1 idempotent re-run: body may change
   * if slices were added/re-run since the PR was first opened).
   */
  updatePrBody(prNumber: number, newBody: string): Promise<void>;
}

/** Context handed to an agent role for one slice. */
export interface AgentContext {
  sliceId: number;
  branch: string;
  /** Findings from a prior review, when re-implementing (S6a). */
  priorFindings?: string[];
}

/** The verdict + metered cost of one review session. */
export interface ReviewResult {
  verdict: Verdict;
  cost: SliceCost;
}

/** The two role agents — guaranteed distinct sessions + models by the caller. */
export interface AgentPort {
  /**
   * Write the slice's code (S2). The real impl is a `pi-coding-agent` session.
   * Returns the metered cost of the implement session.
   */
  implement(ctx: AgentContext): Promise<SliceCost>;
  /**
   * Adversarially review the slice; return a structured verdict + session cost (S6).
   * The cost is accumulated into the slice's running total by the orchestrator.
   */
  review(ctx: AgentContext): Promise<ReviewResult>;
  /**
   * Plan-review agent (T13/T14) — a separate Pi session on a *different
   * model* than the slicer (SPEC §9 invariant #2). Returns a structured
   * verdict the orchestrator combines with deterministic checks.
   */
  planReview(trackId: number): Promise<PlanReviewVerdict>;
}

/**
 * Cost-meter port — called at slice merge time to record actual vs. estimated
 * cost, post a tracker comment, and append to the cost-history JSONL.
 * Implementations MUST NOT throw: overruns are flagged, never halt the build.
 */
export interface CostMeterPort {
  record(params: { sliceId: number; effort: Effort | undefined; cost: SliceCost }): Promise<void>;
}

/** The deterministic verify gate (S3) — the profile's must-pass command. */
export interface VerifyGatePort {
  run(sliceId: number): Promise<{ green: boolean; output?: string }>;
}

export interface OrchestratorPorts {
  tracker: TrackerPort;
  forge: ForgePort;
  agent: AgentPort;
  verify: VerifyGatePort;
  /** Optional cost meter; skipped when absent (cost estimation not configured). */
  costMeter?: CostMeterPort;
}
