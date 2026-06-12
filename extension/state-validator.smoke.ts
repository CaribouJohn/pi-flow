/**
 * Smoke check for the transition validator. Run with:
 *   bun extension/state-validator.smoke.ts
 *
 * Covers: known happy moves, noop, listed forward, escalation whitelist,
 * terminal refusal, unknown state on either side, illegal arrow surfaces
 * legal targets in the reason.
 */

import { validateTransition, SELF_ESCALATION_TARGETS } from "./state-validator.ts";
import { STATES, TRANSITIONS } from "./state-machine.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- Happy paths: every listed forward transition validates as `transition`.
for (const from of STATES) {
  for (const to of TRANSITIONS[from]) {
    const r = validateTransition(from, to);
    check(
      `listed forward ${from} → ${to}`,
      r.ok && r.kind === "transition",
      !r.ok ? r.reason : undefined,
    );
  }
}

// --- Same-state = noop.
for (const s of STATES) {
  const r = validateTransition(s, s);
  check(`noop ${s} → ${s}`, r.ok && r.kind === "noop");
}

// --- Escalation whitelist: legal from every non-terminal state, even when
// the arrow isn't listed.
for (const from of STATES) {
  const terminal = TRANSITIONS[from].length === 0;
  for (const to of SELF_ESCALATION_TARGETS) {
    if (from === to) continue;
    const r = validateTransition(from, to);
    if (terminal) {
      check(
        `escalation ${from} → ${to} refused (terminal)`,
        !r.ok,
        r.ok ? "expected refusal from terminal" : undefined,
      );
    } else {
      check(
        `escalation ${from} → ${to} allowed`,
        r.ok && r.kind === "transition",
        !r.ok ? r.reason : undefined,
      );
    }
  }
}

// --- Terminal refuses any non-noop move (incl. moves listed nowhere).
{
  const r = validateTransition("wontfix", "ready-for-agent");
  check(
    "wontfix → ready-for-agent refused with 'terminal' in reason",
    !r.ok && /terminal/i.test(r.reason),
  );
}

// --- Illegal arrow surfaces the legal targets so the LLM can self-correct.
{
  const r = validateTransition("ready-for-agent", "tracking");
  check(
    "illegal ready-for-agent → tracking lists legal targets",
    !r.ok && /Legal targets from ready-for-agent/.test(r.reason),
    !r.ok ? undefined : "expected refusal",
  );
}

// --- Unknown state names refused with the known list in the reason.
{
  const r1 = validateTransition("not-a-state", "ready-for-agent");
  check(
    "unknown from state refused",
    !r1.ok && /Unknown from/.test(r1.reason) && /needs-triage/.test(r1.reason),
  );
  const r2 = validateTransition("ready-for-agent", "shipped");
  check(
    "unknown to state refused",
    !r2.ok && /Unknown to/.test(r2.reason),
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
