/**
 * Flow state machine — the v1 spine. Pure data + types; no I/O.
 *
 * Per DESIGN.md (v1 decision): states, transitions, and role assignments
 * live in this module, not the profile. Profiles only rename labels. To
 * extend (v2), see DESIGN.md §State machine — profiles will be able to
 * declare extra states with a `role` and an `inserts_between` pair, but
 * the core spine encoded here remains immutable.
 *
 * A5 ships only the data + types. A6 adds `validateTransition`. A7 wires
 * it into the `flow_set_state` tool.
 *
 * If you add or rename a state here, also:
 *  - update `.pi/flow.profile.md` (`labels.state`)
 *  - update `claude-skills/setup-flow/labels.md` and `profile-template.md`
 *  - update `extension/profile.ts` (`StateLabels`, `REQUIRED_STATE_KEYS`)
 *  - update the issue-template label sets under `.github/ISSUE_TEMPLATE/`
 */

/** Canonical state names — match the label strings used by default. */
export const STATES = [
  "needs-triage",
  "needs-info",
  "needs-grilling",
  "needs-slicing",
  "needs-plan-review",
  "tracking",
  "ready-for-agent",
  "ready-for-human",
  "needs-acceptance",
  "wontfix",
] as const;

export type State = (typeof STATES)[number];

/**
 * Kind of state — informs the AFK loop's blocking logic and surfaces in
 * the status widget. Names chosen to be cheap to scan:
 *
 *  - `agent-pickable`  — an autonomous agent can pull this off the queue.
 *  - `human-gated`     — agent stops here; only a human moves it onward.
 *  - `container`       — bookkeeping parent; never worked directly.
 *  - `terminal`        — closed-equivalent; no further work.
 */
export type Role = "agent-pickable" | "human-gated" | "container" | "terminal";

export const STATE_ROLE: Record<State, Role> = {
  "needs-triage": "human-gated",
  "needs-info": "human-gated",
  "needs-grilling": "human-gated",
  "needs-slicing": "agent-pickable",
  "needs-plan-review": "agent-pickable",
  "tracking": "container",
  "ready-for-agent": "agent-pickable",
  "ready-for-human": "human-gated",
  "needs-acceptance": "human-gated",
  "wontfix": "terminal",
};

/**
 * Legal forward transitions, per the flow narrative in
 * `claude-skills/flow/SKILL.md` + the role definitions in
 * `claude-skills/setup-flow/profile-template.md`.
 *
 * Closing an issue (e.g. when a slice ships, when an acceptance is
 * accepted) is NOT modelled as a state transition — there is no
 * "closed" state. The agent closes via `gh issue close` after the merge.
 *
 * When in doubt, err narrow. A6's validator will refuse anything not
 * listed here, and the reviewer will flag missing arrows during code review.
 */
export const TRANSITIONS: Record<State, ReadonlyArray<State>> = {
  // Entry point — maintainer routes to the appropriate next state.
  "needs-triage": [
    "needs-grilling",
    "needs-slicing",
    "ready-for-agent",
    "ready-for-human",
    "needs-info",
    "wontfix",
  ],

  // Human design grill before slicing.
  "needs-grilling": [
    "needs-slicing",
    "ready-for-agent",
    "ready-for-human",
    "needs-info",
    "wontfix",
  ],

  // Agent slices via /to-issues; parent advances to the plan gate.
  "needs-slicing": ["needs-plan-review", "needs-info", "wontfix"],

  // Reviewer agent gates the slice plan.
  "needs-plan-review": ["tracking", "needs-slicing", "needs-info", "wontfix"],

  // Tracking parents are containers — only abandonment is a state move.
  // Normal completion = close (no state transition).
  "tracking": ["wontfix"],

  // Agent works the slice in-place (self-assignment is the in-progress
  // signal). Escalations only — completion = close.
  "ready-for-agent": ["needs-info", "ready-for-human", "wontfix"],

  // Human-only leaf — can be reclaimed by an agent if circumstances change.
  "ready-for-human": ["ready-for-agent", "needs-info", "wontfix"],

  // Reporter clarifies; routed wherever now-appropriate.
  "needs-info": [
    "needs-triage",
    "needs-grilling",
    "needs-slicing",
    "needs-plan-review",
    "ready-for-agent",
    "ready-for-human",
    "needs-acceptance",
    "wontfix",
  ],

  // Back-bookend. Acceptance = close; abandonment = wontfix.
  // Reject-and-redo lives in a corrective issue on the track branch,
  // not a state move on the acceptance issue itself.
  "needs-acceptance": ["wontfix"],

  // Terminal.
  "wontfix": [],
};

/** Convenience: states for the AFK loop's blocking computation. */
export const HUMAN_GATED_STATES: ReadonlyArray<State> = STATES.filter(
  (s) => STATE_ROLE[s] === "human-gated",
);

export const AGENT_PICKABLE_STATES: ReadonlyArray<State> = STATES.filter(
  (s) => STATE_ROLE[s] === "agent-pickable",
);
