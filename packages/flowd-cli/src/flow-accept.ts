/**
 * `flowd accept --track <n>` — A1 acceptance back-bookend (SPEC §5.5).
 *
 * When all non-acceptance slices of the track are closed, this command:
 *  1. Verifies readiness — reports "not ready" if any non-acceptance slice is
 *     still open, without touching anything.
 *  2. Composes a **deterministic** acceptance summary from data flowd already
 *     holds: the merged slice list, each slice's harvested `## Acceptance criteria`
 *     checkboxes, the verify-gate command, a mandatory LIVE exercise checkbox
 *     (SPEC §5.5), the cost roll-up (actual vs estimate), and the
 *     branch-protection warning when present.
 *  3. Opens the track→main PR with that summary (`Closes` the parent + acceptance
 *     issue) — but **does NOT merge it** (invariant #1).
 *  4. Notifies the maintainer via a comment on the acceptance item.
 *  5. Is idempotent: re-running updates the existing open PR rather than
 *     duplicating it.
 *
 * No agent is called. The summary is deterministic from tracker + cost JSONL
 * data. The human holds the merge key.
 */

import type { ForgePort, MainProtection, PullRequest, TrackerPort } from "@pi-flow/flow-engine";
import type { FlowdConfig } from "./config.ts";
import type { CostHistoryRecord } from "./cost-meter.ts";
import { readCostRecords } from "./cost-meter.ts";
import { GitForgeAdapter } from "./git-forge.ts";
import { checkMainProtectionWarning } from "./git-forge.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";

// ── Ports ─────────────────────────────────────────────────────────────────────

/** Minimal forge surface the accept pipeline requires (subset of ForgePort). */
export interface AcceptForge {
  getMainProtection(): Promise<MainProtection>;
  getTrackPr(headBranch: string): Promise<PullRequest | null>;
  openTrackPr(params: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  updatePrBody(prNumber: number, newBody: string): Promise<void>;
}

export interface AcceptPorts {
  tracker: TrackerPort;
  forge: AcceptForge;
}

// ── Config ─────────────────────────────────────────────────────────────────────

export interface AcceptConfig {
  defaultBranch: string;
  verifyCommand: string;
  actor: string;
  aiDisclaimer: string;
  /** Cost history records (pre-read from JSONL; may be empty when not configured). */
  costRecords: CostHistoryRecord[];
}

// ── Input / Output ────────────────────────────────────────────────────────────

export interface AcceptInput {
  track: number;
  config: FlowdConfig;
}

export interface AcceptOutput {
  /** False when non-acceptance slices are still open. */
  ready: boolean;
  /** One line per open slice when ready=false. */
  notReadyReasons?: string[];
  /** PR number (opened or updated). Present only when ready=true. */
  prNumber?: number;
  /** True = new PR; false = existing PR updated (idempotent re-run). */
  created?: boolean;
}

// ── Pure pipeline ─────────────────────────────────────────────────────────────

/**
 * Core accept pipeline (no file I/O, no network calls to real adapters).
 * Extracted from `acceptTrack` so it can be unit-tested with faked ports.
 */
export async function acceptTrackPipeline(
  ports: AcceptPorts,
  trackId: number,
  config: AcceptConfig,
): Promise<AcceptOutput> {
  // 1. Snapshot the world.
  const track = await ports.tracker.getTrack(trackId);
  const slices = await ports.tracker.listSlices(trackId);

  // 2. Readiness check: every non-acceptance slice must be closed.
  const nonAcceptance = slices.filter((s) => s.role !== "needs-acceptance");
  const stillOpen = nonAcceptance.filter((s) => !s.closed);
  if (stillOpen.length > 0) {
    return {
      ready: false,
      notReadyReasons: stillOpen.map((s) => `#${s.id} "${s.title}" is still open (${s.role})`),
    };
  }

  // 3. Find the acceptance item.
  const acceptanceSlice = slices.find((s) => s.role === "needs-acceptance" && !s.closed);
  const acceptanceId = acceptanceSlice?.id;

  // 4. Harvest acceptance criteria from each merged slice.
  const mergedSlices: { id: number; title: string; criteria: string[] }[] = [];
  for (const slice of nonAcceptance) {
    const body = await ports.tracker.getItemBody(slice.id);
    const criteria = harvestAcceptanceCriteria(body);
    mergedSlices.push({ id: slice.id, title: slice.title, criteria });
  }

  // 5. Main-branch protection warning.
  const protection = await ports.forge.getMainProtection();
  const protectionWarning = checkMainProtectionWarning(protection, config.actor);

  // 6. Compose the PR body.
  const sliceIds = new Set(nonAcceptance.map((s) => s.id));
  const prBody = buildAcceptanceSummary({
    trackId,
    acceptanceId,
    mergedSlices,
    verifyCommand: config.verifyCommand,
    costRecords: config.costRecords,
    sliceIds,
    protectionWarning,
    aiDisclaimer: config.aiDisclaimer,
  });

  const prTitle = `Acceptance: ${track.branch} → ${config.defaultBranch}`;

  // 7. Open or update the track→main PR (idempotent).
  const existingPr = await ports.forge.getTrackPr(track.branch);
  let prNumber: number;
  let created: boolean;

  if (existingPr !== null) {
    await ports.forge.updatePrBody(existingPr.number, prBody);
    prNumber = existingPr.number;
    created = false;
  } else {
    const pr = await ports.forge.openTrackPr({
      head: track.branch,
      base: config.defaultBranch,
      title: prTitle,
      body: prBody,
    });
    prNumber = pr.number;
    created = true;
  }

  // 8. Notify via comment on the acceptance item (or track parent as fallback).
  const notifyTarget = acceptanceId ?? trackId;
  await ports.tracker.comment(
    notifyTarget,
    buildNotifyComment(prNumber, created, config.aiDisclaimer),
  );

  return { ready: true, prNumber, created };
}

// ── Real-adapter wiring ───────────────────────────────────────────────────────

/**
 * Wire the real GitHub tracker + forge adapters and run the acceptance pipeline.
 * Reads cost records from the configured JSONL file before delegating to the
 * pure pipeline.
 */
export async function acceptTrack(input: AcceptInput): Promise<AcceptOutput> {
  const { config } = input;

  const tracker = new GitHubTrackerAdapter({
    repo: config.repo,
    trackBranch: config.trackBranch,
  });

  const forge = new GitForgeAdapter({
    repo: config.repo,
    workdir: config.workdir,
    defaultBranch: config.defaultBranch,
  });

  const costRecords = config.costMeter ? await readCostRecords(config.costMeter.historyPath) : [];

  return acceptTrackPipeline({ tracker, forge }, input.track, {
    defaultBranch: config.defaultBranch,
    verifyCommand: config.verifyCommand,
    actor: config.actor,
    aiDisclaimer: config.aiDisclaimer,
    costRecords,
  });
}

// ── Summary builder ───────────────────────────────────────────────────────────

export interface SummaryParams {
  trackId: number;
  acceptanceId: number | undefined;
  mergedSlices: { id: number; title: string; criteria: string[] }[];
  verifyCommand: string;
  costRecords: CostHistoryRecord[];
  sliceIds: Set<number>;
  protectionWarning: string | null;
  aiDisclaimer: string;
}

/**
 * Compose the deterministic acceptance summary for the track→main PR body.
 * Pure function — no I/O, always produces the same output for the same inputs.
 */
export function buildAcceptanceSummary(params: SummaryParams): string {
  const {
    trackId,
    acceptanceId,
    mergedSlices,
    verifyCommand,
    costRecords,
    sliceIds,
    protectionWarning,
    aiDisclaimer,
  } = params;

  const lines: string[] = [];

  if (aiDisclaimer) {
    lines.push(aiDisclaimer, "");
  }

  lines.push("## Acceptance summary", "");

  // ── Merged slices ─────────────────────────────────────────────────────────
  lines.push("### Slices merged", "");
  if (mergedSlices.length === 0) {
    lines.push("_(no slices)_");
  } else {
    for (const s of mergedSlices) {
      lines.push(`- #${s.id} ${s.title}`);
    }
  }
  lines.push("");

  // ── Acceptance criteria (harvested from slice bodies) ─────────────────────
  const allCriteria = mergedSlices.flatMap((s) => s.criteria.map((c) => `${c} _(#${s.id})_`));
  if (allCriteria.length > 0) {
    lines.push("### Acceptance criteria", "");
    for (const c of allCriteria) lines.push(c);
    lines.push("");
  }

  // ── Verify gate ───────────────────────────────────────────────────────────
  lines.push("### Verify gate", "");
  lines.push("```", verifyCommand, "```", "");
  lines.push(`Run \`${verifyCommand}\` and confirm it exits clean before merging.`, "");

  // ── Cost roll-up ──────────────────────────────────────────────────────────
  const relevantRecords = costRecords.filter((r) => sliceIds.has(r.sliceId));
  if (relevantRecords.length > 0) {
    lines.push("### Cost roll-up", "");
    lines.push("| Slice | Actual (USD) | Estimate (USD) |");
    lines.push("|-------|-------------|----------------|");
    let totalActual = 0;
    let totalEst = 0;
    let hasEst = false;
    for (const r of relevantRecords) {
      const est = r.estUSD !== null ? `$${r.estUSD.toFixed(4)}` : "—";
      if (r.estUSD !== null) {
        totalEst += r.estUSD;
        hasEst = true;
      }
      totalActual += r.costUSD;
      lines.push(`| #${r.sliceId} | $${r.costUSD.toFixed(4)} | ${est} |`);
    }
    const estTotal = hasEst ? `$${totalEst.toFixed(4)}` : "—";
    lines.push(`| **Total** | **$${totalActual.toFixed(4)}** | **${estTotal}** |`);
    lines.push("");
  }

  // ── Branch-protection warning ─────────────────────────────────────────────
  if (protectionWarning !== null) {
    lines.push("### ⚠ Branch-protection warning", "");
    lines.push(protectionWarning, "");
  }

  // ── Mandatory live exercise checkbox (SPEC §5.5) ──────────────────────────
  lines.push("### Live exercise", "");
  lines.push("- [ ] LIVE: run the real entry path end-to-end", "");

  // ── Closes keywords (auto-close parent + acceptance on merge) ─────────────
  lines.push(`Closes #${trackId}`);
  if (acceptanceId !== undefined) {
    lines.push(`Closes #${acceptanceId}`);
  }

  return lines.join("\n");
}

// ── Acceptance-criteria harvester ─────────────────────────────────────────────

/**
 * Extract `- [ ] ...` and `- [x] ...` checkboxes from the `## Acceptance criteria`
 * section of a markdown body.  The leading `- [ ] ` / `- [x] ` prefix is preserved
 * so the output can be pasted verbatim into the PR summary.
 * Returns an empty array when the section is absent or has no checkboxes.
 */
export function harvestAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^#{1,6}\s+acceptance criteria\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // Stop at the next heading.
      if (/^#{1,6}\s/.test(line)) break;
      // Collect any checkbox line.
      if (/^\s*-\s+\[[ xX]\]/.test(line)) {
        results.push(line.trimStart());
      }
    }
  }

  return results;
}

// ── Notification comment ──────────────────────────────────────────────────────

/**
 * Build the comment posted to the acceptance item when the PR is opened/updated.
 */
export function buildNotifyComment(
  prNumber: number,
  created: boolean,
  aiDisclaimer: string | undefined,
): string {
  const action = created ? "opened" : "updated";
  const body = [
    `🎯 **Acceptance PR ${action}**: #${prNumber} is ready for your review.`,
    "",
    "**Action required:** review the acceptance summary, run the live exercise, then merge when satisfied.",
    "",
    "_This PR will not be merged automatically — merge authority rests with you (invariant #1)._",
  ].join("\n");
  return aiDisclaimer ? `${aiDisclaimer}\n\n${body}` : body;
}
