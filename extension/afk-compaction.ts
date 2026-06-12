/**
 * B11 — Auto-compact the orchestrator session when token usage crosses
 * a threshold during a long AFK run.
 *
 * Pattern from `examples/extensions/trigger-compact.ts`: hook `turn_end`,
 * read `ctx.getContextUsage().tokens`, fire only on the *edge* (previous
 * tick was ≤ threshold, current is > threshold). Never fires twice while
 * the session stays above the threshold.
 *
 * Pure helpers are exported so the smoke can verify them without a real
 * pi / ctx.
 */

export const DEFAULT_COMPACT_THRESHOLD = 100_000;

/**
 * Resolve the effective compact threshold from an optional profile value.
 *
 * Rules:
 *  - If the value is a positive finite number → use it.
 *  - Otherwise (undefined, null, NaN, ≤ 0, non-number) → DEFAULT.
 *
 * Exported for smoke testing.
 */
export function resolveCompactThreshold(
  profileValue: number | undefined | null,
): number {
  if (
    typeof profileValue === "number" &&
    Number.isFinite(profileValue) &&
    profileValue > 0
  ) {
    return profileValue;
  }
  return DEFAULT_COMPACT_THRESHOLD;
}

/**
 * Decide whether the threshold was just crossed.
 *
 * Returns true iff:
 *   - `previousTokens` was a known value (not null — null means
 *     "first tick, no prior baseline")
 *   - `previousTokens` was ≤ threshold (was safe)
 *   - `currentTokens` is > threshold (now above)
 *
 * Pure: no side effects. Exported for smoke testing.
 */
export function isEdgeCross(
  previousTokens: number | null,
  currentTokens: number,
  threshold: number,
): boolean {
  if (previousTokens === null) return false;
  return previousTokens <= threshold && currentTokens > threshold;
}

/**
 * Build the custom instructions string passed to `ctx.compact()`.
 *
 * The instructions tell the post-compaction orchestrator what to
 * preserve about the current AFK run so it can resume without
 * losing track of in-flight work.
 *
 * Exported for smoke testing.
 */
export function buildCompactInstructions(opts: {
  afkActive: boolean;
  trackBranch: string | null;
  iterMap: Map<number, number>;
  recentMutationIssues: number[];
}): string {
  const lines: string[] = [
    "# pi-flow AFK orchestrator — post-compaction resume guide",
    "",
    "You have just been compacted. The following state was active:",
    "",
    `AFK loop: ${opts.afkActive ? "ACTIVE" : "inactive"}`,
    `Track branch: ${opts.trackBranch ?? "(none)"}`,
  ];

  if (opts.iterMap.size > 0) {
    lines.push("", "Iteration counts (issue# → count):");
    for (const [issue, count] of opts.iterMap) {
      lines.push(`  #${issue} → ${count}`);
    }
  }

  if (opts.recentMutationIssues.length > 0) {
    lines.push(
      "",
      `Issues with recent mutations (do not re-apply): ${opts.recentMutationIssues.map((n) => `#${n}`).join(", ")}`,
    );
  }

  lines.push(
    "",
    "On resume: if AFK was ACTIVE, use /flow-afk to restart the loop.",
    "Do NOT re-implement or re-merge any issue already closed.",
  );

  return lines.join("\n");
}

/**
 * Wire the turn_end hook into `pi`.
 *
 * `pi` and `ctx` shapes are injected so the smoke can drive this with
 * a fake ExtensionAPI without needing a real pi session.
 *
 * The caller (index.ts) passes the live pi instance; everything else
 * is a closure over module-scope state.
 */
export function wireAutoCompact(opts: {
  pi: {
    on(
      event: "turn_end",
      handler: (event: unknown, ctx: CompactCtx) => void,
    ): void;
  };
  getAfkActive(): boolean;
  getTrackBranch(): string | null;
  getIterMap(): Map<number, number>;
  getRecentMutationIssues(): number[];
  getThreshold(): number;
  /** For error-path: apply review:human label on in-flight issue. */
  onCompactError(err: Error): void;
}): void {
  let previousTokens: number | null = null;

  opts.pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage?.();
    const currentTokens = usage?.tokens ?? null;
    if (currentTokens === null) {
      return;
    }

    const threshold = opts.getThreshold();
    const edge = isEdgeCross(previousTokens, currentTokens, threshold);
    previousTokens = currentTokens;

    if (!edge) return;

    const instructions = buildCompactInstructions({
      afkActive: opts.getAfkActive(),
      trackBranch: opts.getTrackBranch(),
      iterMap: opts.getIterMap(),
      recentMutationIssues: opts.getRecentMutationIssues(),
    });

    ctx.compact({
      customInstructions: instructions,
      onComplete: () => {
        if (ctx.hasUI) {
          ctx.ui?.notify("pi-flow: context compacted (AFK resume state preserved).", "info");
        }
      },
      onError: (err: Error) => {
        if (ctx.hasUI) {
          ctx.ui?.notify(`pi-flow: compaction failed: ${err.message}`, "error");
        }
        opts.onCompactError(err);
      },
    });
  });
}

/** Narrow view of the ctx passed to turn_end and compact callbacks. */
export type CompactCtx = {
  getContextUsage?(): { tokens: number } | null | undefined;
  compact(opts: {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (err: Error) => void;
  }): void;
  hasUI: boolean;
  ui?: { notify(msg: string, level: string): void };
};
