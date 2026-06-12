/**
 * Smoke check for the profile reader. Run with:
 *   bun extension/profile.smoke.ts
 *
 * Exits non-zero on parse failure so it can serve as a verify-gate step
 * once the profile reader is on the critical path.
 */

import { readProfile, profilePathFor } from "./profile.ts";

const cwd = process.cwd();
const path = profilePathFor(cwd);

try {
  const profile = readProfile(cwd);
  console.log(`OK  parsed ${path}`);
  console.log(`    tracker:               ${profile.tracker}`);
  console.log(`    repo:                  ${profile.repo}`);
  console.log(`    default_branch:        ${profile.default_branch}`);
  console.log(`    track_branch_prefix:   ${profile.track_branch_prefix}`);
  console.log(`    verify_gate:           ${profile.verify_gate}`);
  console.log(`    reviewer_command:      ${profile.reviewer_command}`);
  console.log(`    reviewer_iteration_cap:${profile.reviewer_iteration_cap}`);
  console.log(`    poll_cadence_seconds:  ${profile.poll_cadence_seconds}`);
  console.log(`    ai_disclaimer:         ${profile.ai_disclaimer}`);
  console.log(`    labels.state.ready_for_agent: ${profile.labels.state.ready_for_agent}`);
  console.log(`    body length:           ${profile.body.length} chars`);
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
