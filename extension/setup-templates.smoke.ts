/**
 * Smoke check for setup-templates. Run with:
 *   bun extension/setup-templates.smoke.ts
 *
 * Covers:
 *   - First run on a clean dir writes all bundled templates.
 *   - Mkdir is called even when the dir doesn't exist.
 *   - Second run with overwrite:false skips every existing file.
 *   - Third run with overwrite:true rewrites all (and new contents win).
 *   - Mixed state: partial overlap → only the missing one is written.
 *   - Empty bundled set throws (catches a bad ship).
 *   - The three real shipped YAMLs all parse and declare the expected
 *     top-level fields (`name`, `labels`, `body`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  createSetupTemplates,
  ISSUE_TEMPLATE_DIR,
  bundledTemplatesDir,
  type BundledTemplate,
  type SetupTemplatesFs,
} from "./setup-templates.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

/** In-memory fs stub that records every mutation. */
function makeFs(initial: Record<string, string> = {}): SetupTemplatesFs & {
  files: Map<string, string>;
  mkdirCalls: string[];
} {
  const files = new Map<string, string>(Object.entries(initial));
  const mkdirCalls: string[] = [];
  return {
    files,
    mkdirCalls,
    exists: (p) => files.has(p),
    mkdirp: (p) => { mkdirCalls.push(p); },
    writeFile: (p, c) => { files.set(p, c); },
  };
}

const CWD = "/repo";
const DEST = join(CWD, ISSUE_TEMPLATE_DIR);

const SAMPLE: BundledTemplate[] = [
  { name: "slice.yml",    contents: "name: Slice\n" },
  { name: "tracking.yml", contents: "name: Tracking\n" },
  { name: "triage.yml",   contents: "name: Triage\n" },
];
const loadBundled = () => SAMPLE;

// First run on clean dir
{
  const fs = makeFs();
  const r = await createSetupTemplates({ loadBundled, cwd: CWD, fs }).apply();
  check(
    "clean dir: writes all three",
    JSON.stringify(r.written.sort()) ===
      JSON.stringify(["slice.yml", "tracking.yml", "triage.yml"]) &&
      r.skippedExisting.length === 0,
    JSON.stringify(r),
  );
  check(
    "clean dir: mkdirp called for ISSUE_TEMPLATE dir",
    fs.mkdirCalls.length === 1 && fs.mkdirCalls[0] === DEST,
  );
  check(
    "clean dir: file contents match bundled",
    fs.files.get(join(DEST, "slice.yml")) === "name: Slice\n",
  );
}

// Second run with overwrite:false skips everything
{
  const preExisting: Record<string, string> = {};
  for (const t of SAMPLE) preExisting[join(DEST, t.name)] = "OLD";
  const fs = makeFs(preExisting);
  const r = await createSetupTemplates({ loadBundled, cwd: CWD, fs }).apply();
  check(
    "all exist + overwrite:false: skipped all, wrote none",
    r.written.length === 0 && r.skippedExisting.length === 3,
    JSON.stringify(r),
  );
  check(
    "all exist + overwrite:false: contents unchanged",
    fs.files.get(join(DEST, "slice.yml")) === "OLD",
  );
}

// Overwrite:true rewrites all
{
  const preExisting: Record<string, string> = {};
  for (const t of SAMPLE) preExisting[join(DEST, t.name)] = "OLD";
  const fs = makeFs(preExisting);
  const r = await createSetupTemplates({ loadBundled, cwd: CWD, fs }).apply({
    overwrite: true,
  });
  check(
    "overwrite:true: writes all three, skips none",
    r.written.length === 3 && r.skippedExisting.length === 0,
    JSON.stringify(r),
  );
  check(
    "overwrite:true: new contents win",
    fs.files.get(join(DEST, "slice.yml")) === "name: Slice\n",
  );
}

// Mixed state — only missing one is written
{
  const fs = makeFs({ [join(DEST, "triage.yml")]: "OLD" });
  const r = await createSetupTemplates({ loadBundled, cwd: CWD, fs }).apply();
  check(
    "partial: writes slice.yml + tracking.yml; skips triage.yml",
    JSON.stringify(r.written.sort()) ===
      JSON.stringify(["slice.yml", "tracking.yml"]) &&
      JSON.stringify(r.skippedExisting) === JSON.stringify(["triage.yml"]),
    JSON.stringify(r),
  );
  check(
    "partial: triage.yml unchanged",
    fs.files.get(join(DEST, "triage.yml")) === "OLD",
  );
}

// Empty bundled set is a bad ship — throw loud
{
  const fs = makeFs();
  let threw: Error | null = null;
  try {
    await createSetupTemplates({
      loadBundled: () => [],
      cwd: CWD,
      fs,
    }).apply();
  } catch (e) {
    threw = e as Error;
  }
  check(
    "empty bundled set throws with actionable message",
    threw !== null && /no bundled templates/i.test(threw!.message),
  );
}

// --- Real shipped YAMLs --------------------------------------------------
// Belt-and-braces: the actual files in the repo parse, and declare every
// field GitHub's issue-form schema requires us to think about.
{
  const realDir = bundledTemplatesDir(process.cwd());
  const names = readdirSync(realDir).filter((n) => n.endsWith(".yml")).sort();
  check(
    "ships exactly the three named templates",
    JSON.stringify(names) ===
      JSON.stringify(["slice.yml", "tracking.yml", "triage.yml"]),
    JSON.stringify(names),
  );
  for (const n of names) {
    const doc = YAML.parse(readFileSync(join(realDir, n), "utf8"));
    check(
      `${n}: parses with name/labels/body`,
      typeof doc?.name === "string" &&
        Array.isArray(doc?.labels) &&
        doc.labels.length > 0 &&
        Array.isArray(doc?.body) &&
        doc.body.length > 0,
      JSON.stringify({ name: doc?.name, labels: doc?.labels }),
    );
  }
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
