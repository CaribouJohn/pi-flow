/**
 * Smoke check for the mutation registry. Run with:
 *   bun extension/mutation-registry.smoke.ts
 *
 * Covers: record then consume returns the token; consume returns null
 * after expiry; consume removes; peek does not remove; concurrent records
 * for same issue overwrite (latest wins, which matches the
 * "agent just mutated again" intent).
 */

import { createMutationRegistry } from "./mutation-registry.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// record + consume
{
  const r = createMutationRegistry(1000);
  const t = r.record(42, "ready-for-agent");
  check("record returns token with future expiry", t.expiresAt > t.recordedAt);
  const c = r.consume(42);
  check("consume returns the token", c?.newState === "ready-for-agent");
  check("consume removes (second consume is null)", r.consume(42) === null);
  check("size is 0 after consume", r.size() === 0);
}

// peek does not remove
{
  const r = createMutationRegistry(1000);
  r.record(7, "needs-info");
  check("peek finds token", r.peek(7)?.newState === "needs-info");
  check("peek leaves token in place", r.peek(7)?.newState === "needs-info");
  check("size is 1 after peeks", r.size() === 1);
}

// expiry
{
  const r = createMutationRegistry(50);
  r.record(99, "wontfix");
  const future = Date.now() + 10_000;
  check("consume returns null when expired", r.consume(99, future) === null);
}

// overwrite
{
  const r = createMutationRegistry(10_000);
  r.record(11, "ready-for-agent");
  r.record(11, "needs-info");
  const c = r.consume(11);
  check("latest record wins", c?.newState === "needs-info");
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
