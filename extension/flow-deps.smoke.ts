/**
 * Smoke check for body-parsing helpers. Run with:
 *   bun extension/flow-deps.smoke.ts
 */

import { parseDependsOn, parseTrackParent } from "./flow-deps.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// parseDependsOn
{
  const r = parseDependsOn(`
**Tracked:** #1

## Depends on
Depends on: #4
`);
  check("single dep", JSON.stringify(r) === "[4]");
}
{
  const r = parseDependsOn(`
## Depends on
Depends on: #5
Depends on: #10
Depends on: #11
Depends on: #12
`);
  check("multiple deps lines", JSON.stringify(r) === "[5,10,11,12]");
}
{
  const r = parseDependsOn(`Depends on: #4, #7 and #9 too`);
  check("comma-separated deps", JSON.stringify(r) === "[4,7,9]");
}
{
  const r = parseDependsOn(`Some other text mentioning #99 elsewhere`);
  check("ignores #N not on a Depends on line", JSON.stringify(r) === "[]");
}
{
  const r = parseDependsOn(`Depends on: #7\nDepends on: #7`);
  check("dedupes", JSON.stringify(r) === "[7]");
}

// parseTrackParent
{
  check(
    "tracked bold",
    parseTrackParent(`**Tracked:** #1\nblah`) === 1,
  );
  check(
    "tracked plain",
    parseTrackParent(`Tracked: #42`) === 42,
  );
  check("no tracked", parseTrackParent(`no parent here`) === null);
  check(
    "first tracked wins",
    parseTrackParent(`Tracked: #2\nTracked: #5`) === 2,
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
