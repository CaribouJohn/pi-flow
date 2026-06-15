/**
 * In-memory fakes for the four orchestrator ports, backed by one mutable world.
 * Tests configure per-slice review verdicts and verify results, run the loop,
 * and inspect the resulting state. No network, no git.
 */
import type {
  AgentContext,
  AgentPort,
  Effort,
  ForgePort,
  OrchestratorPorts,
  PlanReviewVerdict,
  PullRequest,
  ReviewPolicy,
  Role,
  Track,
  TrackerPort,
  TrackerSlice,
  Verdict,
  VerifyGatePort,
} from "../src/index.ts";

export interface FakeSliceSpec {
  id: number;
  role?: Role;
  effort?: Effort;
  review?: ReviewPolicy;
  dependsOn?: number[];
  assignee?: string | null;
  closed?: boolean;
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
  planReviewVerdict?: PlanReviewVerdict | null;
  /** If set, planReview throws instead of returning a verdict (simulate agent failure). */
  planReviewError?: Error;
}

interface Rec {
  id: number;
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
    /** Track branches created by createTrackBranch (idempotent). */
    createTrackBranch: string[];
    /** Role changes made via setRole: (itemId, newRole). */
    roleChanges: { id: number; role: Role }[];
    /** planReview calls to the agent. */
    planReview: number[];
  };
}

const APPROVE: Verdict = { decision: "APPROVE", findings: [] };

export function makeFakeFlow(config: FakeConfig): FakeFlow {
  const track: Track = {
    id: config.trackId ?? 1,
    branch: config.trackBranch ?? "track/test",
    role: config.trackRole ?? "tracking",
  };

  const recs = new Map<number, Rec>(
    config.slices.map((s) => [
      s.id,
      {
        id: s.id,
        role: s.role ?? "ready-for-agent",
        effort: s.effort,
        review: s.review ?? "agent",
        dependsOn: s.dependsOn ?? [],
        assignee: s.assignee ?? null,
        closed: s.closed ?? false,
        branch: null,
        pr: null,
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
    createTrackBranch: [],
    roleChanges: [],
    planReview: [],
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
      track.role = role;
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
  };

  const agent: AgentPort = {
    implement: async (ctx: AgentContext) => {
      counts.implement.push({ sliceId: ctx.sliceId, priorFindings: ctx.priorFindings });
    },
    review: async (ctx: AgentContext): Promise<Verdict> => {
      counts.review.push(ctx.sliceId);
      return reviewQueues.get(ctx.sliceId)?.shift() ?? APPROVE;
    },
    planReview: async (trackId): Promise<PlanReviewVerdict> => {
      counts.planReview.push(trackId);
      if (config.planReviewError) throw config.planReviewError;
      if (config.planReviewVerdict === undefined) {
        throw new Error("fake: no plan-review verdict configured");
      }
      if (config.planReviewVerdict === null) {
        throw new Error("fake: plan-review verdict is null (simulates missing agent)");
      }
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
