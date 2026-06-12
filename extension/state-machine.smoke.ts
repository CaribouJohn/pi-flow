/**
 * Smoke check for the state machine. Run with:
 *   bun extension/state-machine.smoke.ts
 *
 * Exits non-zero on any structural failure (missing role, missing transition
 * entry, transition pointing at an unknown state, no path from triage to
 * acceptance). A6 grows this with `validateTransition` cases.
 */

import {
  STATES,
  STATE_ROLE,
  TRANSITIONS,
  HUMAN_GATED_STATES,
  AGENT_PICKABLE_STATES,
  type State,
} from "./state-machine.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`OK   ${label}`);
  } else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

const stateSet = new Set<string>(STATES);

// Every state has a role.
for (const s of STATES) {
  check(`STATE_ROLE has ${s}`, s in STATE_ROLE);
}

// Every state has a transition entry.
for (const s of STATES) {
  check(`TRANSITIONS has ${s}`, s in TRANSITIONS);
}

// Every target in any TRANSITIONS list is itself a known state.
for (const s of STATES) {
  for (const t of TRANSITIONS[s]) {
    check(
      `TRANSITIONS[${s}] → ${t} is a known state`,
      stateSet.has(t),
      `'${t}' not in STATES`,
    );
  }
}

// No self-loops (idempotent same-state moves are handled by the validator,
// not by listing them in TRANSITIONS).
for (const s of STATES) {
  check(
    `TRANSITIONS[${s}] has no self-loop`,
    !TRANSITIONS[s].includes(s),
  );
}

// At least one path from `needs-triage` to `needs-acceptance` exists
// (BFS over TRANSITIONS).
function pathExists(from: State, to: State): boolean {
  const seen = new Set<State>([from]);
  const queue: State[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) return true;
    for (const next of TRANSITIONS[cur]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

check(
  "happy path: needs-triage → ... → needs-acceptance",
  pathExists("needs-triage", "needs-acceptance"),
);

// `wontfix` reachable from every state (so every issue can be abandoned).
for (const s of STATES) {
  if (s === "wontfix") continue;
  check(
    `wontfix reachable from ${s}`,
    pathExists(s, "wontfix"),
  );
}

// Role partition sanity.
check(
  `human-gated and agent-pickable are disjoint`,
  HUMAN_GATED_STATES.every((s) => !AGENT_PICKABLE_STATES.includes(s)),
);

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
