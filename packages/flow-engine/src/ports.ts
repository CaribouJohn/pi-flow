/**
 * The adapter ports the orchestrator drives. The engine depends only on these
 * interfaces; real adapters (GitHub `gh`, git/forge, `pi-coding-agent`) and the
 * in-memory test fakes implement them. Keeping the engine behind ports is what
 * lets it stay framework-free (ADR-0016) and unit-testable (SPEC §8.9).
 */
import type {
  PlanReviewVerdict,
  PullRequest,
  Role,
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
  /** Merge the slice PR into its base (the track branch only) (S7). */
  mergePr(prNumber: number): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /**
   * Create the track branch off `main` (T13). Idempotent: skip if the
   * branch already exists so a re-run is a no-op (SPEC §8.8).
   */
  createTrackBranch(branch: string): Promise<void>;
}

/** Context handed to an agent role for one slice. */
export interface AgentContext {
  sliceId: number;
  branch: string;
  /** Findings from a prior review, when re-implementing (S6a). */
  priorFindings?: string[];
}

/** The two role agents — guaranteed distinct sessions + models by the caller. */
export interface AgentPort {
  /** Write the slice's code (S2). The real impl is a `pi-coding-agent` session. */
  implement(ctx: AgentContext): Promise<void>;
  /** Adversarially review the slice; return a structured verdict (S6). */
  review(ctx: AgentContext): Promise<Verdict>;
  /**
   * Plan-review agent (T13/T14) — a separate Pi session on a *different
   * model* than the slicer (SPEC §9 invariant #2). Returns a structured
   * verdict the orchestrator combines with deterministic checks.
   */
  planReview(trackId: number): Promise<PlanReviewVerdict>;
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
}
