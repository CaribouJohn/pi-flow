import { describe, expect, test } from "bun:test";
import { type World, decide, runTrack } from "../src/index.ts";
import { makeFakeFlow } from "./fakes.ts";

const OPTS = { reviewerIterationCap: 2, actor: "flow-bot", aiDisclaimer: "[ai]" };

describe("runTrack — happy path (S0–S8)", () => {
  test("drives a single slice claim → implement → review → merge → close", async () => {
    const flow = makeFakeFlow({ slices: [{ id: 10 }] });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("fixpoint");
    expect(flow.counts.driftRefresh).toBe(1); // S0 on entry
    expect(flow.counts.implement.map((i) => i.sliceId)).toEqual([10]); // S2 once
    expect(flow.counts.review).toEqual([10]); // S6 once
    expect(flow.counts.merged).toEqual([10]); // S7
    expect(flow.counts.deletedBranches).toEqual(["slice/10-test"]);

    const slice = flow.slice(10);
    expect(slice.assignee).toBe("flow-bot"); // S1 claim
    expect(slice.closed).toBe(true);
    expect(slice.pr?.base).toBe("track/test"); // S5 base = track branch

    const kinds = result.steps.map((s) => s.action);
    expect(kinds).toEqual(["claim", "implement", "review", "merge"]);
  });

  test("every tracker comment carries the AI disclaimer", async () => {
    const flow = makeFakeFlow({ slices: [{ id: 10 }] });
    await runTrack(flow.ports, 1, OPTS);
    expect(flow.comments.length).toBeGreaterThan(0);
    expect(flow.comments.every((c) => c.body.startsWith("[ai]"))).toBe(true);
  });
});

describe("runTrack — dependencies", () => {
  test("does not pick a slice with an open dependency, then unblocks it", async () => {
    // 11 depends on 10; only 10 is assignable until it closes.
    const flow = makeFakeFlow({ slices: [{ id: 10 }, { id: 11, dependsOn: [10] }] });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("fixpoint");
    expect(flow.slice(10).closed).toBe(true);
    expect(flow.slice(11).closed).toBe(true);
    // 10 must be worked and merged before 11 is even started (respect dependencies).
    expect(flow.counts.implement.map((i) => i.sliceId)).toEqual([10, 11]);
    expect(flow.counts.merged).toEqual([10, 11]);
  });
});

describe("runTrack — review:human handoff (S6h)", () => {
  test("a review:human slice parks for the maintainer instead of agent review", async () => {
    const flow = makeFakeFlow({ slices: [{ id: 10, review: "human" }] });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toContain("human review");
    expect(flow.counts.review).toEqual([]); // never ran the agent reviewer
    expect(flow.counts.merged).toEqual([]);
    expect(flow.slice(10).pr?.status).toBe("open"); // PR opened, awaiting the human
  });
});

describe("runTrack — review changes loop (S6a), bounded", () => {
  test("REQUEST_CHANGES then APPROVE re-implements once and merges", async () => {
    const flow = makeFakeFlow({
      slices: [{ id: 10 }],
      reviewVerdicts: {
        10: [
          { decision: "REQUEST_CHANGES", findings: ["fix the edge case"] },
          { decision: "APPROVE", findings: [] },
        ],
      },
    });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("fixpoint");
    expect(flow.counts.review).toEqual([10, 10]); // two reviews
    expect(flow.counts.merged).toEqual([10]);
    // re-implement carried the prior findings back to the implementer.
    const reimplement = flow.counts.implement[1];
    expect(reimplement?.priorFindings).toEqual(["fix the edge case"]);
    // the re-implementation is published to origin BEFORE re-review, so the
    // reviewer sees the fix and not the original code (bug #5 regression guard).
    expect(flow.counts.pushed).toContain(10);
    // the verdict + findings are posted to the tracker.
    expect(
      flow.comments.some(
        (c) => c.body.includes("REQUEST_CHANGES") && c.body.includes("fix the edge case"),
      ),
    ).toBe(true);
  });

  test("persistent REQUEST_CHANGES parks at the cap without merging", async () => {
    const flow = makeFakeFlow({
      slices: [{ id: 10 }],
      reviewVerdicts: {
        10: [
          { decision: "REQUEST_CHANGES", findings: ["nope"] },
          { decision: "REQUEST_CHANGES", findings: ["still nope"] },
          { decision: "REQUEST_CHANGES", findings: ["never"] },
        ],
      },
    });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toContain("after 2 review(s)");
    expect(flow.counts.review).toEqual([10, 10]); // capped at 2
    expect(flow.counts.merged).toEqual([]); // never merged
    expect(flow.slice(10).closed).toBe(false);
  });
});

describe("runTrack — verify gate (S3), never merge past red", () => {
  test("a red verify gate parks instead of opening a PR", async () => {
    const flow = makeFakeFlow({
      slices: [{ id: 10 }],
      verifyResults: { 10: [false, false] }, // red every attempt
    });

    const result = await runTrack(flow.ports, 1, OPTS);

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toContain("verify gate red");
    expect(flow.counts.merged).toEqual([]);
    expect(flow.slice(10).pr).toBeNull(); // never opened a PR
  });
});

describe("runTrack — idempotency", () => {
  test("a second run over the finished world is a no-op", async () => {
    const flow = makeFakeFlow({ slices: [{ id: 10 }] });

    await runTrack(flow.ports, 1, OPTS);
    const second = await runTrack(flow.ports, 1, OPTS);

    expect(second.outcome).toBe("fixpoint");
    expect(second.steps).toEqual([]); // no claim/implement/review/merge
  });
});

describe("decide — pure scheduler", () => {
  const base = (over: Partial<World["slices"][number]>): World => ({
    track: { id: 1, branch: "track/test", role: "tracking" },
    slices: [
      {
        id: 10,
        title: "test-slice",
        role: "ready-for-agent",
        review: "agent",
        dependsOn: [],
        assignee: null,
        closed: false,
        branch: null,
        pr: null,
        ...over,
      },
    ],
  });

  test("claims an unblocked, unclaimed, ready-for-agent slice", () => {
    expect(decide(base({}), 2)).toEqual({ kind: "claim", sliceId: 10 });
  });

  test("implements a claimed slice with no PR", () => {
    expect(decide(base({ assignee: "flow-bot" }), 2)).toEqual({ kind: "implement", sliceId: 10 });
  });

  test("reviews a claimed slice with an open PR", () => {
    const w = base({
      assignee: "x",
      branch: "b",
      pr: { number: 1, base: "track/test", status: "open", reviewAttempts: 0 },
    });
    expect(decide(w, 2)).toEqual({ kind: "review", sliceId: 10 });
  });

  test("merges an approved PR", () => {
    const w = base({
      assignee: "x",
      branch: "b",
      pr: { number: 1, base: "track/test", status: "approved", reviewAttempts: 1 },
    });
    expect(decide(w, 2)).toEqual({ kind: "merge", sliceId: 10 });
  });

  test("is done when all slices are closed", () => {
    expect(decide(base({ closed: true }), 2)).toEqual({ kind: "done" });
  });
});
