/**
 * `flowd reject --track <n> --reason <text>` — A3 acceptance back-bookend.
 *
 * When a maintainer finds a defect during live acceptance (A3), this command:
 *  1. Finds the open `needs-acceptance` item on the track.
 *  2. Creates a **corrective slice** issue on the track (role `needs-triage`)
 *     whose body carries the reason, failure evidence, and a
 *     "add the coverage that would have caught it" note, with a link back to
 *     the acceptance issue.
 *  3. Leaves the acceptance issue **open** (the track is not closed).
 *  4. Prefixes the corrective body with the configured AI disclaimer.
 *
 * Triage must promote the corrective to `ready-for-agent` (with exact files +
 * a named verification set) before `flowd run` can pick it up — a freeform
 * reason alone does not satisfy the agent-ready bar (SPEC §5.5 A3).
 */
import type { TrackerPort } from "@pi-flow/flow-engine";
import type { FlowdConfig } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { makeForgeGhRunner, readForgeToken } from "./forge-auth.ts";
import { GitHubTrackerAdapter } from "./github-tracker.ts";

export interface RejectInput {
  /** The track parent issue number. */
  track: number;
  /** Freeform failure reason supplied by the maintainer via `--reason`. */
  reason: string;
  config: FlowdConfig;
}

export interface RejectOutput {
  /** The newly-created corrective slice issue number. */
  correctiveId: number;
  /** The acceptance issue number, or undefined when none was found (unusual). */
  acceptanceId: number | undefined;
}

/**
 * Pure pipeline: find the acceptance item, create the corrective slice.
 * Extracted from `rejectTrack` so it can be unit-tested with a fake tracker.
 */
export async function rejectTrackPipeline(
  tracker: TrackerPort,
  trackId: number,
  reason: string,
  aiDisclaimer: string | undefined,
): Promise<RejectOutput> {
  // Find the open needs-acceptance item for this track.
  const slices = await tracker.listSlices(trackId);
  const acceptance = slices.find((s) => s.role === "needs-acceptance" && !s.closed);
  const acceptanceId = acceptance?.id;

  const correctiveId = await tracker.createItem({
    parentId: trackId,
    role: "needs-triage",
    title: correctiveTitle(reason),
    body: correctiveBody(trackId, acceptanceId, reason, aiDisclaimer),
    review: "agent",
    category: "bug",
    // effort intentionally absent — triage will set it alongside exact files +
    // the named verification set (the agent-ready bar).
  });

  return { correctiveId, acceptanceId };
}

/**
 * Wire the real GitHub tracker and run the rejection pipeline.
 * Does NOT close the acceptance issue — the track remains open.
 */
export async function rejectTrack(input: RejectInput): Promise<RejectOutput> {
  const credentials = new FileCredentialStore(input.config.credentialsPath);
  // Fail fast if the forge PAT is absent — never fall back to ambient auth.
  const forgeToken = await readForgeToken(credentials);
  const tracker = new GitHubTrackerAdapter({
    repo: input.config.repo,
    trackBranch: input.config.trackBranch,
    run: makeForgeGhRunner(forgeToken),
  });
  return rejectTrackPipeline(tracker, input.track, input.reason, input.config.aiDisclaimer);
}

// ── Body / title builders ────────────────────────────────────────────────────

/** Truncate the reason to a sane title length. */
export function correctiveTitle(reason: string): string {
  const prefix = "Corrective: ";
  const max = 72 - prefix.length;
  const snippet = reason.length > max ? `${reason.slice(0, max - 1)}…` : reason;
  return `${prefix}${snippet}`;
}

/**
 * Markdown body for the corrective issue.
 * Carries the AI disclaimer prefix, failure reason, missing-coverage note,
 * and a `Parent: #<trackId>` marker so `listSlices` associates it with the track.
 */
export function correctiveBody(
  trackId: number,
  acceptanceId: number | undefined,
  reason: string,
  aiDisclaimer: string | undefined,
): string {
  const acceptanceLine =
    acceptanceId !== undefined ? `\n**Acceptance issue:** #${acceptanceId}\n` : "";

  const body = [
    `## Corrective slice — acceptance rejected on track #${trackId}`,
    acceptanceLine,
    "## Failure reason",
    "",
    reason,
    "",
    "## Coverage gap",
    "",
    "A defect caught at acceptance means the verify gate did not catch it.",
    "Add a test that would have caught this failure before it reached acceptance.",
    "",
    `Parent: #${trackId}`,
  ].join("\n");

  return aiDisclaimer ? `${aiDisclaimer}\n\n${body}` : body;
}
