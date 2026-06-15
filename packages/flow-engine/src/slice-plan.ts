/**
 * Slice-plan schema + deterministic writer — the non-LLM half of T12
 * (SPEC §5.2, PRD-0003 §4.2, §11 slice 2).
 *
 * The `slice` agent (Pi session, read-only doc tools) produces a `SlicePlan`
 * via `submit_slice_plan`. This module **validates** that plan (rejecting
 * dangling/cyclic `dependsOn` indices before any side-effect) and **writes**
 * the child Items + the acceptance Item through the engine's tracker port.
 *
 * Every tracker write is an orchestrator action (SPEC §8.4); per-child dedup
 * makes re-runs idempotent (SPEC §8.8).
 */
import type { SliceEntry, SlicePlan, SlicePlanResult } from "./domain.ts";
import { type RunOptions, disclaim } from "./orchestrator.ts";
import type { OrchestratorPorts } from "./ports.ts";

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a slice plan **before any issue is created**.
 * Returns an array of error messages (empty ⇒ valid).
 *
 * Checks:
 *  - Non-empty slices array
 *  - Every `dependsOn` index is in bounds (0..slices.length-1)
 *  - No reference cycles in the dependency graph
 */
export function validateSlicePlan(plan: SlicePlan): string[] {
  const errors: string[] = [];

  if (plan.slices.length === 0) {
    errors.push("Slice plan must contain at least one slice");
  }

  // Collect all validation errors before returning (don't short-circuit).
  for (let i = 0; i < plan.slices.length; i++) {
    const entry = plan.slices[i];
    if (!entry) continue;
    const deps = entry.dependsOn;
    if (!deps || deps.length === 0) continue;
    for (const dep of deps) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= plan.slices.length) {
        errors.push(
          `Slice ${i} ("${entry.title}"): dependsOn index ${dep} ` +
            `is out of bounds (plan has ${plan.slices.length} slice(s))`,
        );
      }
    }
  }

  // Cycle detection via DFS over the index graph.
  const cycleResult = detectCycles(plan.slices);
  if (cycleResult !== null) {
    errors.push(cycleResult);
  }

  return errors;
}

/**
 * DFS-based cycle detection over the dependency graph of `dependsOn` indices.
 * Returns a human-readable error message describing the cycle, or null if acyclic.
 */
function detectCycles(slices: SliceEntry[]): string | null {
  const n = slices.length;
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Array<number>(n).fill(WHITE);

  function dfs(u: number, path: number[]): string | null {
    color[u] = GRAY;
    path.push(u);
    const entry = slices[u];
    const deps = entry?.dependsOn ?? [];
    // Sort for deterministic output.
    for (const v of [...deps].sort((a, b) => a - b)) {
      if (v < 0 || v >= n) continue; // out-of-bounds caught by validateSlicePlan
      if (color[v] === GRAY) {
        const cycleStart = path.indexOf(v);
        const cycle = path.slice(cycleStart).concat(v);
        return `Dependency cycle detected: ${cycle
          .map((idx) => `"${slices[idx]?.title ?? `#${idx}`}"`)
          .join(" → ")}`;
      }
      if (color[v] === WHITE) {
        const result = dfs(v, path);
        if (result !== null) return result;
      }
    }
    path.pop();
    color[u] = BLACK;
    return null;
  }

  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE) {
      const result = dfs(i, []);
      if (result !== null) return result;
    }
  }

  return null;
}

// ── Writer ──────────────────────────────────────────────────────────────────

/**
 * Write a validated slice plan to the tracker — the deterministic T12 half.
 *
 * 1. Validate the plan (fail before any side-effect).
 * 2. Idempotency gate: if the parent is past `needs-slicing`, skip entirely.
 * 3. Per-child dedup: for each plan slice, check if an open child with the
 *    same title already exists under this parent. Skip if present.
 * 4. Create each new child Item (role `ready-for-agent`/`ready-for-human`,
 *    axes, agent brief, `Parent: #<n>` marker).
 * 5. Resolve `dependsOn` indices → real issue numbers and write each child's
 *    `## Blocked by` section.
 * 6. Create the acceptance Item (`needs-acceptance`, `review:human`,
 *    `Depends on:` every slice). Dedup this too.
 * 7. Advance parent → `needs-plan-review`.
 */
export async function writeSlicePlan(
  ports: OrchestratorPorts,
  parentId: number,
  plan: SlicePlan,
  opts: RunOptions,
): Promise<SlicePlanResult> {
  // ── Validate first (fail before any side-effect) ──────────────────────────
  const validationErrors = validateSlicePlan(plan);
  if (validationErrors.length > 0) {
    throw new SlicePlanValidationError(validationErrors);
  }

  // ── Idempotency gate ──────────────────────────────────────────────────────
  // If the parent is already past needs-slicing, T12 already ran.
  const track = await ports.tracker.getTrack(parentId);
  if (track.role !== "needs-slicing") {
    // Re-derive existing children.
    const existing = await ports.tracker.listSlices(parentId);
    const childSlices = existing.filter((s) => s.role !== "needs-acceptance" && !s.closed);
    const acceptance = existing.find((s) => s.role === "needs-acceptance" && !s.closed);
    return {
      childIds: childSlices.map((s) => s.id),
      acceptanceId: acceptance?.id,
    };
  }

  // ── Per-child dedup + creation ────────────────────────────────────────────
  const existingSlices = await ports.tracker.listSlices(parentId);
  const existingTitles = new Set<string>();
  for (const s of existingSlices) {
    if (!s.closed) {
      try {
        const body = await ports.tracker.getItemBody(s.id);
        if (body.includes(`Parent: #${parentId}`)) {
          existingTitles.add(s.title);
        }
      } catch {
        // If we can't read the body, treat as non-matching.
      }
    }
  }

  // Build childIds from plan entries. For dedup we need to know each entry's
  // eventual id (existing or newly-created) for dependency resolution.
  const childIds: number[] = [];

  for (const entry of plan.slices) {
    // Dedup: skip if an open child with this title already exists.
    const existing = existingSlices.find(
      (s) => s.title === entry.title && !s.closed && existingTitles.has(s.title),
    );
    if (existing) {
      childIds.push(existing.id);
      continue;
    }

    const role = entry.review === "human" ? "ready-for-human" : "ready-for-agent";
    const body = ["## Brief", "", entry.brief, "", `Parent: #${parentId}`].join("\n");

    const newId = await ports.tracker.createItem({
      parentId,
      role,
      title: entry.title,
      body,
      effort: entry.effort,
      review: entry.review,
      category: entry.category,
    });

    // Mark as existing so a re-run after partial failure still dedups.
    existingTitles.add(entry.title);

    childIds.push(newId);
  }

  // ── Resolve dependsOn indices → real issue numbers ────────────────────────
  for (let i = 0; i < plan.slices.length; i++) {
    const entry = plan.slices[i];
    if (!entry) continue;
    const deps = entry.dependsOn;
    if (!deps || deps.length === 0) continue;

    const cid = childIds[i];
    if (cid === undefined) continue;

    const resolved: number[] = [];
    for (const idx of deps) {
      const depId = childIds[idx];
      if (depId !== undefined) resolved.push(depId);
    }
    if (resolved.length > 0) {
      await ports.tracker.setDependencies(cid, resolved);
    }
  }

  // ── Create the acceptance Item ────────────────────────────────────────────
  const acceptanceTitle = plan.title ? `Acceptance: ${plan.title}` : "Acceptance";

  const existingAcceptance = existingSlices.find(
    (s) => s.role === "needs-acceptance" && !s.closed && s.title === acceptanceTitle,
  );

  let acceptanceId: number;
  if (existingAcceptance) {
    acceptanceId = existingAcceptance.id;
  } else {
    const acceptanceBody = [
      "## Acceptance",
      "",
      "Verify the integrated feature and merge the track to `main`.",
      "",
      `Parent: #${parentId}`,
    ].join("\n");

    acceptanceId = await ports.tracker.createItem({
      parentId,
      role: "needs-acceptance",
      title: acceptanceTitle,
      body: acceptanceBody,
      review: "human",
      category: "enhancement",
    });
  }

  // Acceptance depends on every slice child.
  await ports.tracker.setDependencies(acceptanceId, [...childIds]);

  // ── Advance parent → needs-plan-review ────────────────────────────────────
  await ports.tracker.setRole(parentId, "needs-plan-review");
  await ports.tracker.comment(
    parentId,
    disclaim(
      opts,
      [
        `[slice-plan] Created ${childIds.length} slice(s) and 1 acceptance item.`,
        `Slice IDs: ${childIds.map((id) => `#${id}`).join(", ")}`,
        `Acceptance: #${acceptanceId}`,
      ].join("\n"),
    ),
  );

  return { childIds, acceptanceId };
}

// ── Error types ─────────────────────────────────────────────────────────────

export class SlicePlanValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Slice plan validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "SlicePlanValidationError";
    this.errors = errors;
  }
}
