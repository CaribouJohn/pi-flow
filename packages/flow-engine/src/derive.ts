/**
 * Derived states — computed every tick from the world, never stored as labels
 * (SPEC §4, invariant #5). These are the only inputs to scheduling decisions.
 */
import type { Slice, World } from "./domain.ts";

/** Blocked: any slice named in THIS slice's dependency section is still open. */
export function isBlocked(slice: Slice, world: World): boolean {
  return slice.dependsOn.some((depId) => {
    const dep = world.slices.find((s) => s.id === depId);
    // Unknown refs (outside this track) do not block; only known, open ones do.
    return dep !== undefined && !dep.closed;
  });
}

/** In-progress: the slice has an assignee (an actor claimed it). */
export function isInProgress(slice: Slice): boolean {
  return slice.assignee !== null;
}

/** Implemented: a linked PR is open into the track branch. */
export function isImplemented(slice: Slice): boolean {
  return slice.pr !== null;
}

/** Reviewed: the linked PR is approved. */
export function isReviewed(slice: Slice): boolean {
  return slice.pr?.status === "approved";
}

/** Assignable now: ready-for-agent AND not blocked AND not in-progress (SPEC §4). */
export function isAssignable(slice: Slice, world: World): boolean {
  return (
    slice.role === "ready-for-agent" &&
    !slice.closed &&
    !isInProgress(slice) &&
    !isBlocked(slice, world)
  );
}
