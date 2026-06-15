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
  /** The item title (used for stable-identity dedup at T12). */
  title: string;
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

// ── Slice-plan types (T12 — the contract the slice agent fills) ────────────

/**
 * One entry in a slice plan — the per-slice fields the `slice` agent emits
 * via `submit_slice_plan`. `dependsOn` carries **indices** into the plan's
 * `slices` array, NOT issue numbers; the writer resolves them after creation.
 */
export interface SliceEntry {
  title: string;
  brief: string;
  effort: Effort;
  category: Category;
  review: ReviewPolicy;
  /** Indices into the plan's `slices` array (0-based). Validated for
   * bounds + acyclicity before any issue is created. */
  dependsOn?: number[];
}

/** The full slice plan the agent emits. */
export interface SlicePlan {
  title: string;
  slices: SliceEntry[];
}

/** Result of the deterministic write step (T12). */
export interface SlicePlanResult {
  /** The created (or deduped) child slice issue numbers, in plan order. */
  childIds: number[];
  /** The acceptance item's issue number, or undefined when no open acceptance
   * item exists (possible on a partial-re-run over a past-gate parent). */
  acceptanceId: number | undefined;
}
