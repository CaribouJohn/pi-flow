/**
 * Smoke for afk-compaction. Run with:
 *   bun extension/afk-compaction.smoke.ts
 */

import {
  DEFAULT_COMPACT_THRESHOLD,
  buildCompactInstructions,
  isEdgeCross,
  resolveCompactThreshold,
  wireAutoCompact,
  type CompactCtx,
} from "./afk-compaction.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// ====================================================================
// resolveCompactThreshold
// ====================================================================

check("default threshold value", DEFAULT_COMPACT_THRESHOLD === 100_000);
check("resolveCompactThreshold: undefined → default", resolveCompactThreshold(undefined) === 100_000);
check("resolveCompactThreshold: null → default", resolveCompactThreshold(null) === 100_000);
check("resolveCompactThreshold: NaN → default", resolveCompactThreshold(NaN) === 100_000);
check("resolveCompactThreshold: 0 → default", resolveCompactThreshold(0) === 100_000);
check("resolveCompactThreshold: negative → default", resolveCompactThreshold(-1) === 100_000);
check("resolveCompactThreshold: positive → uses value", resolveCompactThreshold(50_000) === 50_000);
check("resolveCompactThreshold: 1 → valid", resolveCompactThreshold(1) === 1);
check("resolveCompactThreshold: Infinity → default", resolveCompactThreshold(Infinity) === 100_000);

// ====================================================================
// isEdgeCross
// ====================================================================

// First tick (previousTokens=null) → never fires
check("no edge: first tick", !isEdgeCross(null, 150_000, 100_000));

// Below threshold → no fire
check("no edge: prev below, curr below", !isEdgeCross(50_000, 90_000, 100_000));

// Crosses threshold
check("edge: prev ≤ threshold, curr > threshold", isEdgeCross(99_999, 100_001, 100_000));
check("edge: prev = threshold, curr > threshold", isEdgeCross(100_000, 100_001, 100_000));

// Already above → no second fire
check("no edge: prev > threshold, curr > threshold", !isEdgeCross(110_000, 120_000, 100_000));

// Drops below then spikes again — would fire (caller handles prev update)
check("edge: drops then re-crosses", isEdgeCross(80_000, 105_000, 100_000));

// ====================================================================
// buildCompactInstructions
// ====================================================================

{
  const instructions = buildCompactInstructions({
    afkActive: true,
    trackBranch: "track/afk-loop",
    iterMap: new Map([[42, 2], [99, 1]]),
    recentMutationIssues: [42, 55],
  });
  check("instructions: includes AFK ACTIVE", instructions.includes("ACTIVE"));
  check("instructions: includes track branch", instructions.includes("track/afk-loop"));
  check("instructions: includes issue 42 iteration", instructions.includes("#42") && instructions.includes("→ 2"));
  check("instructions: includes issue 99 iteration", instructions.includes("#99") && instructions.includes("→ 1"));
  check("instructions: includes recent mutations", instructions.includes("#42") && instructions.includes("#55"));
  check("instructions: includes resume guide", instructions.includes("/flow-afk"));
}

{
  const instructions = buildCompactInstructions({
    afkActive: false,
    trackBranch: null,
    iterMap: new Map(),
    recentMutationIssues: [],
  });
  check("instructions: inactive AFK", instructions.includes("inactive"));
  check("instructions: no track branch", instructions.includes("(none)"));
  check("instructions: no iteration section when map empty", !instructions.includes("Iteration counts"));
  check("instructions: no mutation section when empty", !instructions.includes("recent mutations"));
}

// ====================================================================
// wireAutoCompact — edge-fire-only semantics
// ====================================================================

{
  const compactCalls: { customInstructions?: string }[] = [];
  const errorCalls: Error[] = [];
  const turnEndHandlers: Array<(evt: unknown, ctx: CompactCtx) => void> = [];
  const mockPi = {
    on: (event: "turn_end", handler: (evt: unknown, ctx: CompactCtx) => void) => {
      if (event === "turn_end") turnEndHandlers.push(handler);
    },
  };

  const iterMap = new Map([[7, 1]]);
  wireAutoCompact({
    pi: mockPi,
    getAfkActive: () => true,
    getTrackBranch: () => "track/afk-loop",
    getIterMap: () => iterMap,
    getRecentMutationIssues: () => [7],
    getThreshold: () => 100_000,
    onCompactError: (e) => errorCalls.push(e),
  });

  check("wireAutoCompact: registers turn_end handler", turnEndHandlers.length === 1);
  const handler = turnEndHandlers[0]!;

  function makeCtx(tokens: number | null, hasUI = true): CompactCtx {
    return {
      getContextUsage: () => (tokens === null ? null : { tokens }),
      compact: (opts) => { compactCalls.push({ customInstructions: opts.customInstructions }); },
      hasUI,
      ui: { notify: () => {} },
    };
  }

  // First tick (null usage) → no fire
  handler({}, makeCtx(null));
  check("wireAutoCompact: null usage → no compact", compactCalls.length === 0);

  // Below threshold → no fire
  handler({}, makeCtx(50_000));
  check("wireAutoCompact: below threshold → no compact", compactCalls.length === 0);

  // Still below → no fire
  handler({}, makeCtx(90_000));
  check("wireAutoCompact: still below → no compact", compactCalls.length === 0);

  // Crosses threshold → fires
  handler({}, makeCtx(110_000));
  check("wireAutoCompact: crosses threshold → compact fires", compactCalls.length === 1);
  check(
    "wireAutoCompact: customInstructions includes AFK state",
    compactCalls[0]!.customInstructions?.includes("track/afk-loop") ?? false,
  );
  check(
    "wireAutoCompact: customInstructions includes iteration",
    compactCalls[0]!.customInstructions?.includes("#7") ?? false,
  );

  // Stays above → no second fire
  handler({}, makeCtx(120_000));
  check("wireAutoCompact: stays above → no double fire", compactCalls.length === 1);

  // Drops below again
  handler({}, makeCtx(80_000));
  check("wireAutoCompact: drops below → no fire", compactCalls.length === 1);

  // Crosses again → fires again (new edge)
  handler({}, makeCtx(105_000));
  check("wireAutoCompact: second crossing → fires again", compactCalls.length === 2);
}

// ====================================================================
// wireAutoCompact — error path relabels
// ====================================================================

{
  const errorCalls: Error[] = [];
  const turnEndHandlers: Array<(evt: unknown, ctx: CompactCtx) => void> = [];
  const mockPi = {
    on: (_: "turn_end", h: (evt: unknown, ctx: CompactCtx) => void) => {
      turnEndHandlers.push(h);
    },
  };
  wireAutoCompact({
    pi: mockPi,
    getAfkActive: () => true,
    getTrackBranch: () => null,
    getIterMap: () => new Map(),
    getRecentMutationIssues: () => [],
    getThreshold: () => 100_000,
    onCompactError: (e) => errorCalls.push(e),
  });
  const handler = turnEndHandlers[0]!;
  // First tick to set previousTokens
  handler({}, {
    getContextUsage: () => ({ tokens: 50_000 }),
    compact: () => {},
    hasUI: false,
  });
  // Crossing — compact will call onError
  const crossErr = new Error("compact failed");
  handler({}, {
    getContextUsage: () => ({ tokens: 110_000 }),
    compact: (opts) => { opts.onError?.(crossErr); },
    hasUI: false,
  });
  check("error path: onCompactError called", errorCalls.length === 1);
  check("error path: correct error forwarded", errorCalls[0]?.message === "compact failed");
}

// ====================================================================
// Done
// ====================================================================

if (failed === 0) {
  console.log("\nALL PASS");
  process.exit(0);
} else {
  console.error(`\n${failed} CHECK(S) FAILED`);
  process.exit(1);
}
