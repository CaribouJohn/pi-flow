/**
 * Pure transition validator over the v1 state machine.
 *
 * Layered on `state-machine.ts`:
 *  - same-state moves are idempotent `noop`s (callers can skip the write)
 *  - listed forward transitions are `transition`s
 *  - `needs-info` / `ready-for-human` are always-legal escalation targets
 *    from any non-terminal state (the AFK-loop guarantee: an agent can
 *    always bail out to a human without first knowing the exact arrow)
 *  - terminal states (`wontfix`) accept no moves, including escalations
 *  - anything else returns a `Result` whose `reason` enumerates the legal
 *    targets so the LLM (or a human reading a comment) has a fix in hand
 *
 * A7 wires this into `flow_set_state`. Keep this module dependency-free
 * (no I/O, no profile, no gh) so the validator stays trivially testable.
 */

import {
  STATES,
  TRANSITIONS,
  type State,
} from "./state-machine.ts";

/** Targets an agent may always move to from any non-terminal state. */
export const SELF_ESCALATION_TARGETS: ReadonlyArray<State> = [
  "needs-info",
  "ready-for-human",
];

export type TransitionResult =
  | { ok: true; kind: "transition" | "noop" }
  | { ok: false; reason: string };

export function isState(s: string): s is State {
  return (STATES as readonly string[]).includes(s);
}

/**
 * Validate a state move. Returns a `TransitionResult` rather than throwing
 * so callers (the tool, the AFK loop, a future dry-run preview) can format
 * the reason however they like.
 */
export function validateTransition(from: string, to: string): TransitionResult {
  if (!isState(from)) {
    return { ok: false, reason: formatUnknownState("from", from) };
  }
  if (!isState(to)) {
    return { ok: false, reason: formatUnknownState("to", to) };
  }

  if (from === to) {
    return { ok: true, kind: "noop" };
  }

  const listed = TRANSITIONS[from];
  if (listed.includes(to)) {
    return { ok: true, kind: "transition" };
  }

  if (listed.length === 0) {
    return { ok: false, reason: formatTerminal(from, to) };
  }

  if (SELF_ESCALATION_TARGETS.includes(to)) {
    return { ok: true, kind: "transition" };
  }

  return { ok: false, reason: formatIllegal(from, to) };
}

function formatUnknownState(side: "from" | "to", name: string): string {
  return `Unknown ${side} state '${name}'. Known: ${STATES.join(", ")}`;
}

function formatTerminal(from: State, to: State): string {
  return [
    `Cannot move from terminal state '${from}' (target was '${to}').`,
    `Terminal states accept no transitions — including escalations.`,
  ].join("\n");
}

function formatIllegal(from: State, to: State): string {
  const legal = TRANSITIONS[from];
  return [
    `Illegal transition: ${from} → ${to}.`,
    `Legal targets from ${from}: ${legal.join(", ")}.`,
    `Always-legal escalation targets (from any non-terminal): ${SELF_ESCALATION_TARGETS.join(", ")}.`,
  ].join("\n");
}
