/**
 * In-memory fakes for the four orchestrator ports, backed by one mutable world.
 * Tests configure per-slice review verdicts and verify results, run the loop,
 * and inspect the resulting state. No network, no git.
 */
import type {
  AgentContext,
  AgentPort,
  Category,
  CreateItemParams,
  Effort,
  ForgePort,
  MainProtection,
  OrchestratorPorts,
  PlanReviewVerdict,
  PullRequest,
  ReviewPolicy,
  ReviewResult,
  Role,
  SliceCost,
  Track,
  TrackerPort,
  TrackerSlice,
  Verdict,
  VerifyGatePort,
} from "../src/index.ts";
import { ZERO_SLICE_COST } from "../src/index.ts";

export interface FakeSliceSpec {
  id: number;
  /** Item title. Defaults to "slice-<id>" if omitted. */
  title?: string;
  role?: Role;
  effort?: Effort;
  review?: ReviewPolicy;
  dependsOn?: number[];
  assignee?: string | null;
  closed?: boolean;
  /** Pre-set the slice branch (e.g. when testing a slice already in progress). */
  branch?: string | null;
  /** Pre-set the slice PR (e.g. a merged-out-of-band PR for §8.8 tests). */
  pr?: PullRequest | null;
}

export interface FakeConfig {
  trackId?: number;
  trackBranch?: string;
  /** The parent item's role. Defaults to `tracking` for legacy tracks. */
  trackRole?: Role;
  slices: FakeSliceSpec[];
  /** Per-slice review verdict queue; defaults to APPROVE when exhausted. */
  reviewVerdicts?: Record<number, Verdict[]>;
  /** Per-slice verify result queue; defaults to green when exhausted. */
  verifyResults?: Record<number, boolean[]>;
  /** Plan-review agent verdict to return. Omit to simulate a missing verdict (escalate). */
  planReviewVerdict?: PlanReviewVerdict;
  /** If set, planReview throws instead of returning a verdict (simulate agent failure). */
  planReviewError?: Error;
  /** Slice ids whose refreshSliceFromTrack returns false (simulate a merge conflict). */
  refreshConflictSlices?: number[];
  /**
   * Main-branch protection state returned by getMainProtection.
   * Defaults to fully protected (requiresPr + requiresNonAuthorApproval = true)
   * so existing tests are unaffected.
   */
  mainProtection?: MainProtection;
  /** Pre-existing track→main PR (for A1 idempotent re-run tests). */
  trackPr?: PullRequest | null;
  /**
   * Initial body of the parent track item.  Defaults to a minimal PRD marker
   * so `getItemBody(trackId)` always succeeds (plan gate reads it on T13 clear).
   */
  parentBody?: string;
}

interface Rec {
  id: number;
  title: string;
  body: string;
  role: Role;
  effort?: Effort;
  review: ReviewPolicy;
  dependsOn: number[];
  assignee: string | null;
  closed: boolean;
  branch: string | null;
  pr: PullRequest | null;
}

export interface FakeFlow {
  ports: OrchestratorPorts;
  /** Current state of a slice, for assertions. */
  slice(id: number): Rec;
  /** The parent track's mutable role, for assertions after plan-gate mutations. */
  track: Track;
  comments: { id: number; body: string }[];
  counts: {
    driftRefresh: number;
    implement: { sliceId: number; priorFindings?: string[] }[];
    review: number[];
    merged: number[];
    deletedBranches: string[];
    /** Slice ids whose branch was pushed to origin (S6a re-implement). */
    pushed: number[];
    /** Slice ids refreshed against the track before merge (S7). */
    refreshed: number[];
    /** Track branches created by createTrackBranch (idempotent). */
    createTrackBranch: string[];
    /** Role changes made via setRole: (itemId, newRole). */
    roleChanges: { id: number; role: Role }[];
    /** planReview calls to the agent. */
    planReview: number[];
    /** Items created via createItem: (parentId, title, newId). */
    createdItems: { parentId: number; title: string; id: number; role: Role }[];
    /** Dependency writes via setDependencies: (itemId, dependsOn[]). */
    dependencyWrites: { id: number; dependsOn: number[] }[];
    /** Track PR opens via openTrackPr (A1). */
    openedTrackPr: { head: string; base: string; title: string; body: string }[];
    /** PR body updates via updatePrBody (A1 re-run). */
    updatedPrBodies: { prNumber: number; newBody: string }[];
    /** Body updates via updateBody: (itemId, body). */
    bodyUpdates: { id: number; body: string }[];
  };
}

const APPROVE: Verdict = { decision: "APPROVE", findings: [] };

export function makeFakeFlow(config: FakeConfig): FakeFlow {
  const track: Track = {
    id: config.trackId ?? 1,
    branch: config.trackBranch ?? "track/test",
    role: config.trackRole ?? "tracking",
  };

  // Parent item body — writable by updateBody (used by plan gate to persist
  // the Track-branch marker on T13 clear).  Tests can inspect it via getItemBody.
  let parentBody = config.parentBody ?? "PRD: docs/prd/test.md\n";

  const recs = new Map<number, Rec>(
    config.slices.map((s) => [
      s.id,
      {
        id: s.id,
        title: s.title ?? `slice-${s.id}`,
        body: `## Brief\n\nFake body for slice ${s.id}\n\nParent: #${config.trackId ?? 1}`,
        role: s.role ?? "ready-for-agent",
        effort: s.effort,
        review: s.review ?? "agent",
        dependsOn: s.dependsOn ?? [],
        assignee: s.assignee ?? null,
        closed: s.closed ?? false,
        branch: s.branch ?? null,
        pr: s.pr ?? null,
      },
    ]),
  );

  const reviewQueues = new Map<number, Verdict[]>(
    Object.entries(config.reviewVerdicts ?? {}).map(([k, v]) => [Number(k), [...v]]),
  );
  const verifyQueues = new Map<number, boolean[]>(
    Object.entries(config.verifyResults ?? {}).map(([k, v]) => [Number(k), [...v]]),
  );

  const comments: FakeFlow["comments"] = [];
  const counts: FakeFlow["counts"] = {
    driftRefresh: 0,
    implement: [],
    review: [],
    merged: [],
    deletedBranches: [],
    pushed: [],
    refreshed: [],
    createTrackBranch: [],
    roleChanges: [],
    planReview: [],
    createdItems: [],
    dependencyWrites: [],
    openedTrackPr: [],
    updatedPrBodies: [],
    bodyUpdates: [],
  };
  let prCounter = 100;

  const must = (id: number): Rec => {
    const rec = recs.get(id);
    if (rec === undefined) throw new Error(`fake: no slice ${id}`);
    return rec;
  };
  const byPr = (prNumber: number): Rec => {
    for (const rec of recs.values()) if (rec.pr?.number === prNumber) return rec;
    throw new Error(`fake: no slice for PR ${prNumber}`);
  };
  const copyPr = (pr: PullRequest | null): PullRequest | null => (pr === null ? null : { ...pr });

  const tracker: TrackerPort = {
    getTrack: async () => ({ ...track }),
    listSlices: async (): Promise<TrackerSlice[]> =>
      [...recs.values()].map((r) => ({
        id: r.id,
        title: r.title,
        role: r.role,
        effort: r.effort,
        review: r.review,
        dependsOn: [...r.dependsOn],
        assignee: r.assignee,
        closed: r.closed,
      })),
    setAssignee: async (id, who) => {
      must(id).assignee = who;
    },
    closeSlice: async (id) => {
      must(id).closed = true;
    },
    comment: async (id, body) => {
      comments.push({ id, body });
    },
    setRole: async (itemId, role) => {
      counts.roleChanges.push({ id: itemId, role });
      // Only mutate track.role when the item is the track parent itself.
      if (itemId === track.id) track.role = role;
    },
    createItem: async (params: CreateItemParams): Promise<number> => {
      const newId = Math.max(100, ...recs.keys()) + 1;
      recs.set(newId, {
        id: newId,
        title: params.title,
        body: params.body,
        role: params.role,
        effort: params.effort,
        review: params.review,
        dependsOn: [],
        assignee: null,
        closed: false,
        branch: null,
        pr: null,
      });
      counts.createdItems.push({
        parentId: params.parentId,
        title: params.title,
        id: newId,
        role: params.role,
      });
      return newId;
    },
    setDependencies: async (itemId, dependsOn) => {
      const rec = must(itemId);
      rec.dependsOn = [...dependsOn];
      counts.dependencyWrites.push({ id: itemId, dependsOn: [...dependsOn] });
    },
    getItemBody: async (itemId) => {
      if (itemId === track.id) return parentBody;
      return must(itemId).body;
    },
    updateBody: async (itemId, body) => {
      counts.bodyUpdates.push({ id: itemId, body });
      if (itemId === track.id) {
        parentBody = body;
      } else {
        must(itemId).body = body;
      }
    },
    listByRole: async (role) => {
      return [...recs.values()].filter((r) => r.role === role && !r.closed).map((r) => r.id);
    },
  };

  const forge: ForgePort = {
    driftRefresh: async () => {
      counts.driftRefresh++;
    },
    getSliceBranch: async (id) => must(id).branch,
    getSlicePr: async (id) => copyPr(must(id).pr),
    createSliceBranch: async (id, _from) => {
      const branch = `slice/${id}-test`;
      must(id).branch = branch;
      return branch;
    },
    openPr: async (id, base) => {
      const pr: PullRequest = { number: ++prCounter, base, status: "open", reviewAttempts: 0 };
      must(id).pr = pr;
      return { ...pr };
    },
    pushSlice: async (sliceId) => {
      counts.pushed.push(sliceId);
    },
    recordReviewVerdict: async (prNumber, verdict) => {
      const rec = byPr(prNumber);
      if (rec.pr === null) throw new Error("fake: PR vanished");
      rec.pr.reviewAttempts++;
      rec.pr.lastFindings = verdict.findings;
      rec.pr.status = verdict.decision === "APPROVE" ? "approved" : "changes-requested";
    },
    reopenForReview: async (prNumber) => {
      const rec = byPr(prNumber);
      if (rec.pr !== null) rec.pr.status = "open";
    },
    refreshSliceFromTrack: async (sliceId) => {
      counts.refreshed.push(sliceId);
      return !(config.refreshConflictSlices ?? []).includes(sliceId);
    },
    mergePr: async (prNumber) => {
      const rec = byPr(prNumber);
      counts.merged.push(rec.id);
    },
    deleteBranch: async (branch) => {
      counts.deletedBranches.push(branch);
    },
    createTrackBranch: async (branch) => {
      counts.createTrackBranch.push(branch);
    },
    getMainProtection: async () =>
      config.mainProtection ?? { requiresPr: true, requiresNonAuthorApproval: true },
    getTrackPr: async (headBranch: string) => {
      if (headBranch !== track.branch) {
        throw new Error(
          `fake: getTrackPr called with branch "${headBranch}" but track branch is "${track.branch}"`,
        );
      }
      const pr = config.trackPr ?? null;
      return pr === null ? null : { ...pr };
    },
    openTrackPr: async (params) => {
      const pr: PullRequest = {
        number: ++prCounter,
        base: params.base,
        status: "open",
        reviewAttempts: 0,
      };
      counts.openedTrackPr.push({ ...params });
      return { ...pr };
    },
    updatePrBody: async (prNumber, newBody) => {
      counts.updatedPrBodies.push({ prNumber, newBody });
    },
  };

  const agent: AgentPort = {
    implement: async (ctx: AgentContext): Promise<SliceCost> => {
      counts.implement.push({ sliceId: ctx.sliceId, priorFindings: ctx.priorFindings });
      return ZERO_SLICE_COST;
    },
    review: async (ctx: AgentContext): Promise<ReviewResult> => {
      counts.review.push(ctx.sliceId);
      const verdict = reviewQueues.get(ctx.sliceId)?.shift() ?? APPROVE;
      return { verdict, cost: ZERO_SLICE_COST };
    },
    planReview: async (trackId): Promise<PlanReviewVerdict> => {
      counts.planReview.push(trackId);
      if (config.planReviewError) throw config.planReviewError;
      if (config.planReviewVerdict === undefined) {
        throw new Error("fake: no plan-review verdict configured");
      }
      // The "agent returned null / missing verdict" path is exercised via
      // `planReviewError` (throw → caught by runPlanGate → combineVerdict(null))
      // and directly in plan-review.test.ts; no separate null branch needed.
      return config.planReviewVerdict;
    },
  };

  const verify: VerifyGatePort = {
    run: async (sliceId) => ({ green: verifyQueues.get(sliceId)?.shift() ?? true }),
  };

  return {
    ports: { tracker, forge, agent, verify },
    slice: must,
    track,
    comments,
    counts,
  };
}
