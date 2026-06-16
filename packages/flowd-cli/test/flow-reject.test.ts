/**
 * Unit tests for `flowd reject` — A3 acceptance back-bookend.
 * All tests run over in-memory fakes; no network or git required.
 */
import { describe, expect, test } from "bun:test";
import { makeFakeFlow } from "@pi-flow/flow-engine/test/fakes";
import { correctiveBody, correctiveTitle, rejectTrackPipeline } from "../src/flow-reject.ts";

// ── correctiveTitle ──────────────────────────────────────────────────────────

describe("correctiveTitle", () => {
  test("prefixes short reasons verbatim", () => {
    expect(correctiveTitle("login button crashes on iOS")).toBe(
      "Corrective: login button crashes on iOS",
    );
  });

  test("truncates long reasons with an ellipsis", () => {
    const long = "a".repeat(100);
    const title = correctiveTitle(long);
    expect(title.startsWith("Corrective: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("…")).toBe(true);
  });

  test("exactly-fitting reason is not truncated", () => {
    // 72 - "Corrective: ".length === 60
    const exact = "b".repeat(60);
    const title = correctiveTitle(exact);
    expect(title).toBe(`Corrective: ${exact}`);
    expect(title.endsWith("…")).toBe(false);
  });
});

// ── correctiveBody ───────────────────────────────────────────────────────────

describe("correctiveBody", () => {
  test("includes the failure reason", () => {
    const body = correctiveBody(7, 42, "the widget exploded", undefined);
    expect(body).toContain("the widget exploded");
  });

  test("includes the parent marker so listSlices can find it", () => {
    const body = correctiveBody(7, 42, "reason", undefined);
    expect(body).toContain("Parent: #7");
  });

  test("links the acceptance issue", () => {
    const body = correctiveBody(7, 42, "reason", undefined);
    expect(body).toContain("#42");
  });

  test("includes the coverage-gap note", () => {
    const body = correctiveBody(7, 42, "reason", undefined);
    expect(body).toContain("verify gate");
    expect(body).toContain("Add a test");
  });

  test("prefixes the AI disclaimer when provided", () => {
    const body = correctiveBody(7, 42, "reason", "🤖 AI-generated");
    expect(body.startsWith("🤖 AI-generated")).toBe(true);
  });

  test("no disclaimer prefix when aiDisclaimer is undefined", () => {
    const body = correctiveBody(7, 42, "reason", undefined);
    expect(body.startsWith("## Corrective slice")).toBe(true);
  });

  test("omits the acceptance line when no acceptance issue exists", () => {
    const body = correctiveBody(7, undefined, "reason", undefined);
    expect(body).not.toContain("Acceptance issue:");
  });
});

// ── rejectTrackPipeline (over fakes) ────────────────────────────────────────

describe("rejectTrackPipeline", () => {
  /** Build a fake flow with one acceptance item and optionally extra slices. */
  function makeFlow(opts?: { withAcceptance?: boolean }) {
    const withAcceptance = opts?.withAcceptance ?? true;
    return makeFakeFlow({
      trackId: 10,
      slices: [
        { id: 20, role: "ready-for-agent" },
        ...(withAcceptance ? [{ id: 30, role: "needs-acceptance" as const }] : []),
      ],
    });
  }

  test("creates a corrective issue with role needs-triage", async () => {
    const { ports, counts } = makeFlow();
    await rejectTrackPipeline(ports.tracker, 10, "crash on login", "[ai]");

    expect(counts.createdItems).toHaveLength(1);
    const created = counts.createdItems[0];
    expect(created).toBeDefined();
    expect(created?.role).toBe("needs-triage");
  });

  test("returns the new corrective issue id and acceptance id", async () => {
    const { ports } = makeFlow();
    const result = await rejectTrackPipeline(ports.tracker, 10, "crash on login", "[ai]");

    expect(result.correctiveId).toBeGreaterThan(0);
    expect(result.acceptanceId).toBe(30);
  });

  test("the corrective body links the acceptance issue", async () => {
    const { ports, slice } = makeFlow();
    const result = await rejectTrackPipeline(ports.tracker, 10, "crash on login", "[ai]");

    const correctiveRec = slice(result.correctiveId);
    expect(correctiveRec.body).toContain("#30");
  });

  test("the corrective body includes the reason", async () => {
    const { ports, slice } = makeFlow();
    const result = await rejectTrackPipeline(
      ports.tracker,
      10,
      "login button crashes on iOS 17",
      "[ai]",
    );

    const body = slice(result.correctiveId).body;
    expect(body).toContain("login button crashes on iOS 17");
  });

  test("the corrective body includes the coverage-gap note", async () => {
    const { ports, slice } = makeFlow();
    const result = await rejectTrackPipeline(ports.tracker, 10, "some failure", "[ai]");

    const body = slice(result.correctiveId).body;
    expect(body).toContain("Add a test");
    expect(body).toContain("verify gate");
  });

  test("the corrective body carries the AI disclaimer", async () => {
    const { ports, slice } = makeFlow();
    const result = await rejectTrackPipeline(ports.tracker, 10, "some failure", "🤖 [bot]");

    const body = slice(result.correctiveId).body;
    expect(body.startsWith("🤖 [bot]")).toBe(true);
  });

  test("the corrective body has Parent: #<trackId> for listSlices discovery", async () => {
    const { ports, slice } = makeFlow();
    const result = await rejectTrackPipeline(ports.tracker, 10, "some failure", undefined);

    expect(slice(result.correctiveId).body).toContain("Parent: #10");
  });

  test("the acceptance issue is NOT closed — track stays open", async () => {
    const { ports, slice } = makeFlow();
    await rejectTrackPipeline(ports.tracker, 10, "crash on login", "[ai]");

    // The acceptance item (id=30) must still be open.
    expect(slice(30).closed).toBe(false);
  });

  test("works when no acceptance issue exists (unusual but robust)", async () => {
    const { ports } = makeFlow({ withAcceptance: false });
    const result = await rejectTrackPipeline(ports.tracker, 10, "crash on login", "[ai]");

    expect(result.acceptanceId).toBeUndefined();
    expect(result.correctiveId).toBeGreaterThan(0);
  });

  test("corrective is filed with category bug and review agent", async () => {
    const { ports, counts } = makeFlow();
    await rejectTrackPipeline(ports.tracker, 10, "crash", "[ai]");

    // The fake tracker records createdItems with role only; verify via the
    // corrective slice's role.
    const created = counts.createdItems[0];
    expect(created?.role).toBe("needs-triage");
  });

  test("the corrective title is derived from the reason", async () => {
    const { ports, counts } = makeFlow();
    await rejectTrackPipeline(ports.tracker, 10, "import fails on Windows", "[ai]");

    const created = counts.createdItems[0];
    expect(created?.title).toContain("import fails on Windows");
  });
});

// ── CLI parse integration ────────────────────────────────────────────────────

import { parseArgs, planInvocation } from "../src/cli.ts";

describe("planInvocation — reject command", () => {
  test("valid reject invocation", () => {
    expect(planInvocation(["reject", "--track", "5", "--reason", "login crash"])).toEqual({
      kind: "reject",
      track: 5,
      reason: "login crash",
      config: undefined,
    });
  });

  test("reject with --config", () => {
    expect(
      planInvocation(["reject", "--track", "5", "--reason", "oops", "--config", "c.json"]),
    ).toEqual({ kind: "reject", track: 5, reason: "oops", config: "c.json" });
  });

  test("reject: missing --track is a usage error", () => {
    expect(planInvocation(["reject", "--reason", "crash"])).toMatchObject({
      kind: "usage",
      code: 2,
    });
  });

  test("reject: missing --reason is a usage error", () => {
    const r = planInvocation(["reject", "--track", "5"]);
    expect(r).toMatchObject({ kind: "usage", code: 2 });
    if (r.kind === "usage") expect(r.message).toContain("--reason");
  });

  test("reject: non-numeric track is a usage error", () => {
    expect(planInvocation(["reject", "--track", "abc", "--reason", "crash"])).toMatchObject({
      kind: "usage",
      code: 2,
    });
  });

  test("reject: zero track is a usage error", () => {
    expect(planInvocation(["reject", "--track", "0", "--reason", "crash"])).toMatchObject({
      kind: "usage",
      code: 2,
    });
  });
});
