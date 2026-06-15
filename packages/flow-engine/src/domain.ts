/**
 * Domain model for the Flow engine — the entities the reducer operates over.
 * Mirrors `docs/SPEC.md` §1–§4. Canonical (profile-independent) names; a profile
 * maps these to a tracker's label strings elsewhere.
 */

/** The single load-bearing state — exactly one per triaged item (SPEC §2). */
export type Role =
  | "needs-triage"
  | "needs-info"
  | "needs-grilling"
  | "needs-slicing"
  | "needs-plan-review"
  | "tracking"
  | "ready-for-agent"
  | "ready-for-human"
  | "needs-acceptance"
  | "wontfix";

/** Orthogonal axes (SPEC §3). */
export type Effort = "low" | "medium" | "high";
export type ReviewPolicy = "agent" | "human";
export type Category = "bug" | "enhancement";

/** A reviewer's structured verdict (SPEC §5.4 S6). */
export type ReviewDecision = "APPROVE" | "REQUEST_CHANGES";

export interface Verdict {
  decision: ReviewDecision;
  findings: string[];
}

/** Forge state of a slice's pull request into the track branch. */
export type PrStatus = "open" | "approved" | "changes-requested";

export interface PullRequest {
  number: number;
  /** Base branch — for a slice PR this MUST be the track branch (invariant #6). */
  base: string;
  status: PrStatus;
  /** How many times this PR has been reviewed (bounds the changes loop, S6a). */
  reviewAttempts: number;
  /** Findings from the most recent review, fed back on re-implement (S6a). */
  lastFindings?: string[];
}

/**
 * The tracker-owned fields of a slice (what the tracker adapter returns).
 * Volatile/derived states (blocked/in-progress/…) are NOT stored here — they
 * are computed every tick (SPEC §4, invariant #5).
 */
export interface TrackerSlice {
  id: number;
  role: Role;
  effort?: Effort;
  review: ReviewPolicy;
  /** Ids referenced in the slice's dependency section only (SPEC §4 `blocked`). */
  dependsOn: number[];
  /** The in-progress claim — the only cross-worker lock (SPEC §4, invariant #9). */
  assignee: string | null;
  closed: boolean;
}

/** A slice as the reducer sees it: tracker fields + forge-derived state. */
export interface Slice extends TrackerSlice {
  branch: string | null;
  pr: PullRequest | null;
}

export interface Track {
  id: number;
  /** The track branch (`track/<slug>`), off which slices branch (SPEC §1). */
  branch: string;
  /** The parent item's role (SPEC §2). Defaults to `tracking` for legacy tracks. */
  role: Role;
}

/** Plan-review gate types (SPEC §5.3 T13/T14). */
export type PlanReviewDecision = "CLEAR" | "ESCALATE";

/** Per-child agent-ready check emitted by the plan-review agent. */
export interface AgentReadyCheck {
  pass: boolean;
  reason?: string;
}

/**
 * The structured verdict the plan-review agent returns via `submit_plan_review`.
 * The orchestrator combines it with deterministic escalation smells (§4.4).
 */
export interface PlanReviewVerdict {
  decision: PlanReviewDecision;
  risks: string[];
  /** Per-child agent-ready results, keyed by child issue number. */
  childAgentReady: Record<number, AgentReadyCheck>;
}

/** A snapshot of the world the reducer decides over, read fresh each tick. */
export interface World {
  track: Track;
  slices: Slice[];
}
