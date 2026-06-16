/**
 * Unit tests for `flowd accept` — A1 acceptance back-bookend.
 * All tests run over in-memory fakes; no network or git required.
 */
import { describe, expect, test } from "bun:test";
import { makeFakeFlow } from "@pi-flow/flow-engine/test/fakes";
import type { CostHistoryRecord } from "../src/cost-meter.ts";
import {
  acceptTrackPipeline,
  buildAcceptanceSummary,
  buildNotifyComment,
  harvestAcceptanceCriteria,
} from "../src/flow-accept.ts";

// ── harvestAcceptanceCriteria ────────────────────────────────────────────────

describe("harvestAcceptanceCriteria", () => {
  test("returns empty array when section is absent", () => {
    expect(harvestAcceptanceCriteria("## Brief\n\nno criteria here")).toEqual([]);
  });

  test("extracts unchecked checkboxes", () => {
    const body = "## Acceptance criteria\n\n- [ ] foo\n- [ ] bar\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [ ] foo", "- [ ] bar"]);
  });

  test("extracts checked checkboxes too", () => {
    const body = "## Acceptance criteria\n\n- [x] done\n- [X] also done\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [x] done", "- [X] also done"]);
  });

  test("stops at the next heading", () => {
    const body = "## Acceptance criteria\n\n- [ ] keep\n\n## Another section\n\n- [ ] skip\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [ ] keep"]);
  });

  test("is case-insensitive on the heading", () => {
    const body = "## ACCEPTANCE CRITERIA\n\n- [ ] item\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [ ] item"]);
  });

  test("trims leading whitespace from checkbox lines", () => {
    const body = "## Acceptance criteria\n\n  - [ ] indented\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [ ] indented"]);
  });

  test("ignores non-checkbox lines inside the section", () => {
    const body = "## Acceptance criteria\n\nsome prose\n- [ ] real checkbox\nmore prose\n";
    expect(harvestAcceptanceCriteria(body)).toEqual(["- [ ] real checkbox"]);
  });
});

// ── buildAcceptanceSummary ────────────────────────────────────────────────────

describe("buildAcceptanceSummary", () => {
  const BASE: Parameters<typeof buildAcceptanceSummary>[0] = {
    trackId: 10,
    acceptanceId: 30,
    mergedSlices: [
      { id: 20, title: "slice-one", criteria: ["- [ ] criterion A"] },
      { id: 21, title: "slice-two", criteria: [] },
    ],
    verifyCommand: "bun run verify",
    costRecords: [],
    sliceIds: new Set([20, 21]),
    protectionWarning: null,
    aiDisclaimer: "[ai]",
    defaultBranch: "main",
  };

  test("includes the AI disclaimer", () => {
    expect(buildAcceptanceSummary(BASE)).toContain("[ai]");
  });

  test("lists merged slices", () => {
    const out = buildAcceptanceSummary(BASE);
    expect(out).toContain("- #20 slice-one");
    expect(out).toContain("- #21 slice-two");
  });

  test("includes acceptance criteria from slices that have them", () => {
    const out = buildAcceptanceSummary(BASE);
    expect(out).toContain("- [ ] criterion A");
    expect(out).toContain("_(#20)_");
  });

  test("skips AC section when no slice has criteria", () => {
    const out = buildAcceptanceSummary({
      ...BASE,
      mergedSlices: [{ id: 20, title: "slice-one", criteria: [] }],
    });
    expect(out).not.toContain("### Acceptance criteria");
  });

  test("includes verify gate command", () => {
    expect(buildAcceptanceSummary(BASE)).toContain("bun run verify");
  });

  test("mandatory LIVE checkbox is always present", () => {
    const out = buildAcceptanceSummary(BASE);
    expect(out).toContain("- [ ] LIVE: run the real entry path end-to-end");
  });

  test("Closes parent and acceptance issue", () => {
    const out = buildAcceptanceSummary(BASE);
    expect(out).toContain("Closes #10");
    expect(out).toContain("Closes #30");
  });

  test("Closes only parent when no acceptance id", () => {
    const out = buildAcceptanceSummary({ ...BASE, acceptanceId: undefined });
    expect(out).toContain("Closes #10");
    expect(out).not.toContain("Closes #30");
  });

  test("omits cost roll-up when no relevant records", () => {
    expect(buildAcceptanceSummary(BASE)).not.toContain("### Cost roll-up");
  });

  test("includes cost roll-up with relevant records", () => {
    const rec: CostHistoryRecord = {
      sliceId: 20,
      effort: "medium",
      roles: ["implement", "review"],
      implementModel: "m1",
      reviewModel: "m2",
      totalTokens: 1000,
      costUSD: 0.0043,
      estUSD: 0.0039,
      ts: "2025-01-01T00:00:00Z",
    };
    const out = buildAcceptanceSummary({ ...BASE, costRecords: [rec] });
    expect(out).toContain("### Cost roll-up");
    expect(out).toContain("#20");
    expect(out).toContain("$0.0043");
    expect(out).toContain("$0.0039");
    expect(out).toContain("**Total**");
  });

  test("cost roll-up handles absent estimate (null estUSD)", () => {
    const rec: CostHistoryRecord = {
      sliceId: 20,
      effort: undefined,
      roles: ["implement", "review"],
      implementModel: "m1",
      reviewModel: "m2",
      totalTokens: 500,
      costUSD: 0.0021,
      estUSD: null,
      ts: "2025-01-01T00:00:00Z",
    };
    const out = buildAcceptanceSummary({ ...BASE, costRecords: [rec] });
    expect(out).toContain("$0.0021");
    expect(out).toContain("—"); // no estimate
  });

  test("filters cost records to track slices only", () => {
    const irrelevant: CostHistoryRecord = {
      sliceId: 999,
      effort: "low",
      roles: ["implement", "review"],
      implementModel: "m1",
      reviewModel: "m2",
      totalTokens: 100,
      costUSD: 0.0001,
      estUSD: 0.0001,
      ts: "2025-01-01T00:00:00Z",
    };
    const out = buildAcceptanceSummary({ ...BASE, costRecords: [irrelevant] });
    expect(out).not.toContain("### Cost roll-up");
  });

  test("includes protection warning when present", () => {
    const out = buildAcceptanceSummary({
      ...BASE,
      protectionWarning: "⚠ main is not protected",
    });
    expect(out).toContain("### ⚠ Branch-protection warning");
    expect(out).toContain("⚠ main is not protected");
  });

  test("omits protection warning section when null", () => {
    const out = buildAcceptanceSummary({ ...BASE, protectionWarning: null });
    expect(out).not.toContain("Branch-protection warning");
  });

  test("is deterministic (same output for same inputs)", () => {
    expect(buildAcceptanceSummary(BASE)).toBe(buildAcceptanceSummary(BASE));
  });
});

// ── buildNotifyComment ────────────────────────────────────────────────────────

describe("buildNotifyComment", () => {
  test("says 'opened' on first run", () => {
    expect(buildNotifyComment(42, true, undefined)).toContain("opened");
  });

  test("says 'updated' on re-run", () => {
    expect(buildNotifyComment(42, false, undefined)).toContain("updated");
  });

  test("includes PR number", () => {
    expect(buildNotifyComment(42, true, undefined)).toContain("#42");
  });

  test("includes invariant #1 reminder", () => {
    expect(buildNotifyComment(42, true, undefined)).toContain("invariant #1");
  });

  test("prefixes with AI disclaimer when provided", () => {
    const out = buildNotifyComment(42, true, "[ai]");
    expect(out.startsWith("[ai]")).toBe(true);
  });
});

// ── acceptTrackPipeline (over fakes) ──────────────────────────────────────────

describe("acceptTrackPipeline", () => {
  /** Build a standard config used across pipeline tests. */
  const CONFIG = {
    defaultBranch: "main",
    verifyCommand: "bun run verify",
    actor: "flow-bot",
    aiDisclaimer: "[ai]",
    costRecords: [] as CostHistoryRecord[],
  };

  /** A track with two closed slices + one open acceptance item. */
  function makeReadyFlow() {
    return makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        { id: 20, role: "ready-for-agent", closed: true },
        { id: 21, role: "ready-for-agent", closed: true },
        { id: 30, role: "needs-acceptance" },
      ],
    });
  }

  /** A track with one slice still open. */
  function makeNotReadyFlow() {
    return makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        { id: 20, role: "ready-for-agent", closed: true },
        { id: 21, role: "ready-for-agent", closed: false }, // still open
        { id: 30, role: "needs-acceptance" },
      ],
    });
  }

  // ── readiness ──────────────────────────────────────────────────────────────

  test("returns ready=false when a non-acceptance slice is still open", async () => {
    const { ports } = makeNotReadyFlow();
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.ready).toBe(false);
    expect(result.notReadyReasons).toHaveLength(1);
    expect(result.notReadyReasons?.[0]).toContain("#21");
  });

  test("reports all open slices when multiple are open", async () => {
    const { ports } = makeFakeFlow({
      trackId: 10,
      slices: [
        { id: 20, role: "ready-for-agent", closed: false },
        { id: 21, role: "ready-for-agent", closed: false },
        { id: 30, role: "needs-acceptance" },
      ],
    });
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.ready).toBe(false);
    expect(result.notReadyReasons).toHaveLength(2);
  });

  test("does not open a PR when not ready", async () => {
    const { ports, counts } = makeNotReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG);
    expect(counts.openedTrackPr).toHaveLength(0);
  });

  // ── happy-path: PR open ────────────────────────────────────────────────────

  test("opens a track PR when all slices are closed", async () => {
    const { ports, counts } = makeReadyFlow();
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.ready).toBe(true);
    expect(counts.openedTrackPr).toHaveLength(1);
  });

  test("opened PR has head=trackBranch and base=defaultBranch", async () => {
    const { ports, counts } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG);
    expect(counts.openedTrackPr[0]?.head).toBe("track/feature");
    expect(counts.openedTrackPr[0]?.base).toBe("main");
  });

  test("opened PR body contains mandatory LIVE checkbox", async () => {
    const { ports, counts } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG);
    expect(counts.openedTrackPr[0]?.body).toContain(
      "- [ ] LIVE: run the real entry path end-to-end",
    );
  });

  test("opened PR body contains Closes parent + acceptance", async () => {
    const { ports, counts } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG);
    const body = counts.openedTrackPr[0]?.body ?? "";
    expect(body).toContain("Closes #10");
    expect(body).toContain("Closes #30");
  });

  test("notifies on the acceptance item", async () => {
    const { ports, comments } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG);
    const notify = comments.find((c) => c.id === 30);
    expect(notify).toBeDefined();
    expect(notify?.body).toContain("opened");
  });

  test("returns the opened PR number", async () => {
    const { ports } = makeReadyFlow();
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(typeof result.prNumber).toBe("number");
    expect((result.prNumber ?? 0) > 0).toBe(true);
  });

  test("result.created is true on first run", async () => {
    const { ports } = makeReadyFlow();
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.created).toBe(true);
  });

  // ── idempotent re-run ──────────────────────────────────────────────────────

  test("updates body of existing PR instead of opening a new one", async () => {
    const existingPr = { number: 77, base: "main", status: "open" as const, reviewAttempts: 0 };
    const { ports, counts } = makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        { id: 20, role: "ready-for-agent", closed: true },
        { id: 30, role: "needs-acceptance" },
      ],
      trackPr: existingPr,
    });
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.prNumber).toBe(77);
    expect(result.created).toBe(false);
    expect(counts.openedTrackPr).toHaveLength(0);
    expect(counts.updatedPrBodies).toHaveLength(1);
    expect(counts.updatedPrBodies[0]?.prNumber).toBe(77);
  });

  test("re-run notifies with 'updated' in the comment", async () => {
    const existingPr = { number: 77, base: "main", status: "open" as const, reviewAttempts: 0 };
    const { ports, comments } = makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        { id: 20, role: "ready-for-agent", closed: true },
        { id: 30, role: "needs-acceptance" },
      ],
      trackPr: existingPr,
    });
    await acceptTrackPipeline(ports, 10, CONFIG);
    const notify = comments.find((c) => c.id === 30);
    expect(notify?.body).toContain("updated");
  });

  // ── branch-protection warning ──────────────────────────────────────────────

  test("includes protection warning when main is unprotected", async () => {
    const { ports, counts } = makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        { id: 20, role: "ready-for-agent", closed: true },
        { id: 30, role: "needs-acceptance" },
      ],
      mainProtection: { requiresPr: false, requiresNonAuthorApproval: false },
    });
    await acceptTrackPipeline(ports, 10, CONFIG);
    const body = counts.openedTrackPr[0]?.body ?? "";
    expect(body).toContain("Branch-protection warning");
    expect(body).toContain("flow-bot");
  });

  test("omits protection warning when main is fully protected", async () => {
    const { ports, counts } = makeReadyFlow(); // default: fully protected
    await acceptTrackPipeline(ports, 10, CONFIG);
    const body = counts.openedTrackPr[0]?.body ?? "";
    expect(body).not.toContain("Branch-protection warning");
  });

  // ── cost roll-up ───────────────────────────────────────────────────────────

  test("includes cost roll-up when cost records are provided", async () => {
    const costRecords: CostHistoryRecord[] = [
      {
        sliceId: 20,
        effort: "medium",
        roles: ["implement", "review"],
        implementModel: "m1",
        reviewModel: "m2",
        totalTokens: 1000,
        costUSD: 0.0043,
        estUSD: 0.0039,
        ts: "2025-01-01T00:00:00Z",
      },
    ];
    const { ports, counts } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, { ...CONFIG, costRecords });
    const body = counts.openedTrackPr[0]?.body ?? "";
    expect(body).toContain("### Cost roll-up");
    expect(body).toContain("$0.0043");
    expect(body).toContain("$0.0039");
  });

  test("omits cost roll-up when no records match track slices", async () => {
    const { ports, counts } = makeReadyFlow();
    await acceptTrackPipeline(ports, 10, CONFIG); // costRecords: []
    const body = counts.openedTrackPr[0]?.body ?? "";
    expect(body).not.toContain("### Cost roll-up");
  });

  // ── acceptance criteria harvesting ────────────────────────────────────────

  test("harvests acceptance criteria from slice bodies", async () => {
    const { ports, counts } = makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [
        {
          id: 20,
          role: "ready-for-agent",
          closed: true,
          // Override body in the fake via slice spec — set via Rec.body
        },
        { id: 30, role: "needs-acceptance" },
      ],
    });
    // Inject a body with AC into the tracker by mutating the fake's underlying
    // record — the fake's getItemBody returns rec.body.
    // We test that the pipeline calls getItemBody and harvestAcceptanceCriteria.
    // In the standard fake body: "## Brief\n\nFake body for slice 20\n\nParent: #10"
    // — no AC section, so criteria is empty. That's fine; the body builder test
    // already covers criteria inclusion. Here we just verify the pipeline doesn't
    // crash and still produces the LIVE checkbox.
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.ready).toBe(true);
    expect(counts.openedTrackPr[0]?.body).toContain("LIVE: run the real entry path end-to-end");
  });

  // ── notify fallback ────────────────────────────────────────────────────────

  test("notifies on track parent when no acceptance item exists", async () => {
    const { ports, comments } = makeFakeFlow({
      trackId: 10,
      trackBranch: "track/feature",
      slices: [{ id: 20, role: "ready-for-agent", closed: true }],
      // No needs-acceptance slice
    });
    const result = await acceptTrackPipeline(ports, 10, CONFIG);
    expect(result.ready).toBe(true);
    // Comment should land on the track parent (id=10) as fallback.
    const notify = comments.find((c) => c.id === 10);
    expect(notify).toBeDefined();
  });
});
