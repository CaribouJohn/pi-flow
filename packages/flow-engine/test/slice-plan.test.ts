import { describe, expect, test } from "bun:test";
import {
  type SlicePlan,
  SlicePlanValidationError,
  validateSlicePlan,
  writeSlicePlan,
} from "../src/index.ts";
import { makeFakeFlow } from "./fakes.ts";

const OPTS = { reviewerIterationCap: 2, actor: "flow-bot", aiDisclaimer: "[ai]" };

// ── Schema smoke ────────────────────────────────────────────────────────────

describe("SlicePlan schema", () => {
  test("accepts a valid slice plan", () => {
    const plan: SlicePlan = {
      title: "My Track",
      slices: [
        {
          title: "Add login",
          brief: "Add a basic login page",
          effort: "medium",
          category: "enhancement",
          review: "agent",
        },
        {
          title: "Add dashboard",
          brief: "Add the main dashboard",
          effort: "low",
          category: "enhancement",
          review: "agent",
          dependsOn: [0],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors).toEqual([]);
  });

  test("rejects an empty slices array", () => {
    const plan: SlicePlan = { title: "Empty", slices: [] };
    const errors = validateSlicePlan(plan);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("at least one slice"))).toBe(true);
  });
});

// ── Validation: dangling dependsOn ─────────────────────────────────────────

describe("validateSlicePlan — dangling dependsOn", () => {
  test("rejects an out-of-bounds (too high) index", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [5],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("out of bounds"))).toBe(true);
  });

  test("rejects a negative index", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [-1],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.some((e) => e.includes("out of bounds"))).toBe(true);
  });

  test("reports all out-of-bounds errors, not just the first", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [5, 6],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.filter((e) => e.includes("out of bounds")).length).toBe(2);
  });

  test("accepts a dependsOn index that equals the last valid index", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "A", brief: "a", effort: "low", category: "bug", review: "agent" },
        {
          title: "B",
          brief: "b",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0],
        },
      ],
    };
    expect(validateSlicePlan(plan)).toEqual([]);
  });
});

// ── Validation: cyclic dependsOn ───────────────────────────────────────────

describe("validateSlicePlan — cyclic dependsOn", () => {
  test("rejects a direct 2-node cycle", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [1],
        },
        {
          title: "B",
          brief: "b",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.some((e) => e.includes("Dependency cycle"))).toBe(true);
    expect(errors.some((e) => e.includes('"A"') && e.includes('"B"'))).toBe(true);
  });

  test("rejects a self-loop (slice depends on itself)", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.some((e) => e.includes("Dependency cycle"))).toBe(true);
  });

  test("rejects a 3-node cycle", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [1],
        },
        {
          title: "B",
          brief: "b",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [2],
        },
        {
          title: "C",
          brief: "c",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0],
        },
      ],
    };
    const errors = validateSlicePlan(plan);
    expect(errors.some((e) => e.includes("Dependency cycle"))).toBe(true);
    expect(errors.some((e) => e.includes('"A"') && e.includes('"B"') && e.includes('"C"'))).toBe(
      true,
    );
  });

  test("accepts a DAG (no cycle)", () => {
    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "A", brief: "a", effort: "low", category: "bug", review: "agent" },
        { title: "B", brief: "b", effort: "low", category: "bug", review: "agent" },
        {
          title: "C",
          brief: "c",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0, 1],
        },
        {
          title: "D",
          brief: "d",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [2],
        },
      ],
    };
    expect(validateSlicePlan(plan)).toEqual([]);
  });
});

// ── Validation: fails before side-effects ──────────────────────────────────

describe("writeSlicePlan — fails before side-effects", () => {
  test("throws SlicePlanValidationError with validation errors; does NOT create items", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "A",
          brief: "a",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [99],
        },
      ],
    };

    await expect(writeSlicePlan(flow.ports, 1, plan, OPTS)).rejects.toThrow(
      SlicePlanValidationError,
    );
    // No items were created.
    expect(flow.counts.createdItems).toEqual([]);
    // Parent role unchanged.
    expect(flow.track.role).toBe("needs-slicing");
  });
});

// ── Happy path: full write ─────────────────────────────────────────────────

describe("writeSlicePlan — happy path", () => {
  test("creates children with correct role, axes, brief, and Parent marker", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "My Track",
      slices: [
        {
          title: "Add login page",
          brief: "Add a basic login page with form",
          effort: "medium",
          category: "enhancement",
          review: "agent",
        },
        {
          title: "Add dashboard",
          brief: "Add the main dashboard view",
          effort: "low",
          category: "enhancement",
          review: "human",
        },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(result.childIds.length).toBe(2);
    expect(result.acceptanceId).toBeGreaterThan(0);

    const created = flow.counts.createdItems;
    expect(created.length).toBe(3); // 2 slices + 1 acceptance

    // First child
    const c0 = created.find((c) => c.title === "Add login page");
    expect(c0).toBeDefined();
    expect(c0?.role).toBe("ready-for-agent");

    // Second child (review:human → ready-for-human)
    const c1 = created.find((c) => c.title === "Add dashboard");
    expect(c1).toBeDefined();
    expect(c1?.role).toBe("ready-for-human");

    // Verify body contains Parent marker
    const slice0 = flow.slice(c0?.id ?? 0);
    expect(slice0.body).toContain("Parent: #1");
    expect(slice0.body).toContain("Add a basic login page with form");

    const slice1 = flow.slice(c1?.id ?? 0);
    expect(slice1.body).toContain("Parent: #1");
  });

  test("creates the acceptance item with Depends on every slice", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "My Track",
      slices: [
        { title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" },
        { title: "S2", brief: "s2", effort: "medium", category: "enhancement", review: "agent" },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    const acceptanceId = result.acceptanceId;
    if (acceptanceId === undefined) throw new Error("expected acceptanceId");
    const acceptance = flow.slice(acceptanceId);
    expect(acceptance.role).toBe("needs-acceptance");
    expect(acceptance.review).toBe("human");
    expect(acceptance.closed).toBe(false);

    // Acceptance depends on every child.
    const dw = flow.counts.dependencyWrites.find((w) => w.id === acceptanceId);
    expect(dw).toBeDefined();
    expect(dw?.dependsOn.sort()).toEqual([...result.childIds].sort());
  });

  test("advances parent to needs-plan-review", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(flow.track.role).toBe("needs-plan-review");
    expect(flow.counts.roleChanges).toEqual([{ id: 1, role: "needs-plan-review" }]);
  });

  test("posts a [slice-plan] marker comment with slice IDs", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    const marker = flow.comments.find((c) => c.body.includes("[slice-plan]"));
    expect(marker).toBeDefined();
    const m = marker as NonNullable<typeof marker>;
    expect(m.body).toContain("Created 1 slice(s)");
    expect(m.body).toContain(`#${result.childIds[0]}`);
    expect(m.body.startsWith("[ai]")).toBe(true);
  });
});

// ── dependsOn index → issue-number resolution ──────────────────────────────

describe("writeSlicePlan — dependsOn resolution", () => {
  test("resolves dependsOn indices to real issue numbers", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "Base", brief: "base", effort: "low", category: "bug", review: "agent" },
        {
          title: "Feature",
          brief: "feature",
          effort: "medium",
          category: "enhancement",
          review: "agent",
          dependsOn: [0],
        },
        {
          title: "Polish",
          brief: "polish",
          effort: "low",
          category: "bug",
          review: "agent",
          dependsOn: [0, 1],
        },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(result.childIds.length).toBe(3);

    const baseId = result.childIds[0] ?? 0;
    const featureId = result.childIds[1] ?? 0;
    const polishId = result.childIds[2] ?? 0;

    // Slice 1 (Feature) depends on slice 0 (Base)
    const dw1 = flow.counts.dependencyWrites.find((w) => w.id === featureId);
    expect(dw1).toBeDefined();
    expect(dw1?.dependsOn).toEqual([baseId]);

    // Slice 2 (Polish) depends on slice 0 and 1
    const dw2 = flow.counts.dependencyWrites.find((w) => w.id === polishId);
    expect(dw2).toBeDefined();
    expect(dw2?.dependsOn.sort()).toEqual([baseId, featureId].sort());

    // The dependencies are actually recorded on the fake slices.
    expect(flow.slice(featureId).dependsOn).toEqual([baseId]);
    expect(flow.slice(polishId).dependsOn.sort()).toEqual([baseId, featureId].sort());
  });

  test("a leaf with no dependsOn gets an empty dependency array", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [{ title: "Solo", brief: "solo", effort: "low", category: "bug", review: "agent" }],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);
    const soloId = result.childIds[0] ?? 0;
    expect(flow.slice(soloId).dependsOn).toEqual([]);
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe("writeSlicePlan — idempotency", () => {
  test("skips when parent is already past needs-slicing (needs-plan-review)", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-plan-review",
      slices: [
        { id: 10, title: "existing-slice", role: "ready-for-agent" },
        { id: 11, title: "Acceptance: T", role: "needs-acceptance" },
      ],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    // Re-derived existing children.
    expect(result.childIds).toEqual([10]);
    expect(result.acceptanceId).toBe(11);
    expect(flow.counts.createdItems).toEqual([]);
    expect(flow.counts.roleChanges).toEqual([]);
  });

  test("skips when parent is already tracking", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "tracking",
      slices: [
        { id: 20, title: "built-slice", role: "ready-for-agent" },
        { id: 21, title: "Acceptance: X", role: "needs-acceptance" },
      ],
    });

    const plan: SlicePlan = {
      title: "X",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(result.childIds).toEqual([20]);
    expect(flow.counts.createdItems).toEqual([]);
  });
});

// ── Per-child dedup ────────────────────────────────────────────────────────

describe("writeSlicePlan — per-child dedup", () => {
  test("skips creating a child that already exists with the same title and Parent marker", async () => {
    // The fake seeds bodies with "Parent: #1" by default (matches trackId=1).
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [
        {
          id: 10,
          title: "Add login",
          role: "ready-for-agent",
          closed: false,
        },
      ],
    });

    // Override the default body to explicitly set the Parent marker.
    (flow.slice(10).body as string) = "## Brief\n\nAlready exists\n\nParent: #1";

    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "Add login", brief: "new brief", effort: "low", category: "bug", review: "agent" },
        {
          title: "Add dashboard",
          brief: "dashboard",
          effort: "low",
          category: "bug",
          review: "agent",
        },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    // "Add login" was deduped (id=10), "Add dashboard" was newly created.
    expect(result.childIds).toContain(10);
    expect(result.childIds.length).toBe(2);
    expect(flow.counts.createdItems.length).toBe(2); // 1 new slice + 1 acceptance
    expect(flow.counts.createdItems.some((c) => c.title === "Add login")).toBe(false);
    expect(flow.counts.createdItems.some((c) => c.title === "Add dashboard")).toBe(true);
  });

  test("does NOT dedup a closed child (creates new one)", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [
        {
          id: 10,
          title: "Old slice",
          role: "ready-for-agent",
          closed: true, // <-- closed!
        },
      ],
    });

    (flow.slice(10).body as string) = "## Brief\n\nOld body\n\nParent: #1";

    const plan: SlicePlan = {
      title: "T",
      slices: [
        {
          title: "Old slice",
          brief: "new",
          effort: "low",
          category: "bug",
          review: "agent",
        },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    // A new child was created (not deduped to the closed one).
    expect(result.childIds[0]).not.toBe(10);
    expect(flow.counts.createdItems.some((c) => c.title === "Old slice")).toBe(true);
  });

  test("re-run after partial failure creates no duplicates", async () => {
    // Simulate: 3 slices planned, only the first 2 were created before crash.
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [
        {
          id: 10,
          title: "Slice A",
          role: "ready-for-agent",
          closed: false,
        },
        {
          id: 11,
          title: "Slice B",
          role: "ready-for-agent",
          closed: false,
        },
      ],
    });

    (flow.slice(10).body as string) = "## Brief\n\nA body\n\nParent: #1";
    (flow.slice(11).body as string) = "## Brief\n\nB body\n\nParent: #1";

    // Re-run with all 3 slices in the plan.
    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "Slice A", brief: "a", effort: "low", category: "bug", review: "agent" },
        {
          title: "Slice B",
          brief: "b",
          effort: "medium",
          category: "enhancement",
          review: "agent",
        },
        { title: "Slice C", brief: "c", effort: "low", category: "bug", review: "agent" },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    // Slice A and B are deduped (10, 11), only Slice C is new.
    expect(result.childIds).toContain(10);
    expect(result.childIds).toContain(11);
    expect(result.childIds.length).toBe(3);
    expect(flow.counts.createdItems.filter((c) => c.title === "Slice A")).toEqual([]);
    expect(flow.counts.createdItems.filter((c) => c.title === "Slice B")).toEqual([]);
    expect(flow.counts.createdItems.some((c) => c.title === "Slice C")).toBe(true);
    // No duplicates of any title.
    const titles = flow.counts.createdItems.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("re-run over fully created set creates no new children at all", async () => {
    // All 3 slices + acceptance already exist.
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [
        { id: 10, title: "Slice A", role: "ready-for-agent", closed: false },
        { id: 11, title: "Slice B", role: "ready-for-agent", closed: false },
        { id: 12, title: "Slice C", role: "ready-for-agent", closed: false },
        { id: 13, title: "Acceptance: T", role: "needs-acceptance", closed: false },
      ],
    });

    for (const id of [10, 11, 12]) {
      (flow.slice(id).body as string) = "## Brief\n\nbody\n\nParent: #1";
    }

    const beforeCount = flow.counts.createdItems.length;
    const plan: SlicePlan = {
      title: "T",
      slices: [
        { title: "Slice A", brief: "a", effort: "low", category: "bug", review: "agent" },
        { title: "Slice B", brief: "b", effort: "low", category: "bug", review: "agent" },
        { title: "Slice C", brief: "c", effort: "low", category: "bug", review: "agent" },
      ],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(result.childIds.sort()).toEqual([10, 11, 12].sort());
    expect(result.acceptanceId).toBe(13);
    // No new items were created (only the role change).
    expect(flow.counts.createdItems.length).toBe(beforeCount);
    // But the parent still advances.
    expect(flow.track.role).toBe("needs-plan-review");
  });
});

// ── Acceptance item dedup ──────────────────────────────────────────────────

describe("writeSlicePlan — acceptance dedup", () => {
  test("reuses existing acceptance item on re-run", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [{ id: 10, title: "Acceptance: My Track", role: "needs-acceptance", closed: false }],
    });

    (flow.slice(10).body as string) = "## Acceptance\n\nbody\n\nParent: #1";

    const plan: SlicePlan = {
      title: "My Track",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    const result = await writeSlicePlan(flow.ports, 1, plan, OPTS);

    expect(result.acceptanceId).toBe(10);
    // Only the new slice was created, not a new acceptance item.
    expect(flow.counts.createdItems.filter((c) => c.role === "needs-acceptance")).toEqual([]);
  });
});

// ── Tracker write pattern ──────────────────────────────────────────────────

describe("writeSlicePlan — tracker write pattern", () => {
  test("[slice-plan] marker comment includes the AI disclaimer", async () => {
    const flow = makeFakeFlow({
      trackId: 1,
      trackRole: "needs-slicing",
      slices: [],
    });

    const plan: SlicePlan = {
      title: "T",
      slices: [{ title: "S1", brief: "s1", effort: "low", category: "bug", review: "agent" }],
    };

    await writeSlicePlan(flow.ports, 1, plan, OPTS);

    const marker = flow.comments.find((c) => c.body.includes("[slice-plan]"));
    expect(marker).toBeDefined();
    expect(marker?.body.startsWith("[ai]")).toBe(true);
  });
});
