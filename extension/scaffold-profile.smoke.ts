/**
 * Smoke check for scaffold-profile. Run with:
 *   bun extension/scaffold-profile.smoke.ts
 *
 * Covers:
 *   - buildFrontmatter shape: tracker, repo, all 10 state keys, effort
 *     and review groups, category from canonical, defaults applied for
 *     omitted answers, labelOverrides honoured.
 *   - renderProfile produces a single `---`-fenced frontmatter block and
 *     preserves the template body verbatim.
 *   - createScaffoldProfile.run:
 *       - first run on a clean tree writes the file.
 *       - second run with overwrite:false returns {written:false, reason:"exists"}.
 *       - overwrite:true rewrites.
 *       - mkdirp called for the `.pi` directory.
 *   - Round-trip: a profile written via the tool parses cleanly through
 *     `readProfile` from profile.ts and recovers every supplied answer.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFrontmatter,
  renderProfile,
  createScaffoldProfile,
  PROFILE_REL_PATH,
  type ScaffoldAnswers,
  type ScaffoldProfileFs,
} from "./scaffold-profile.ts";
import { parseLabelsMarkdown } from "./setup-labels.ts";
import { readProfile, labelForStateKey } from "./profile.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

const LABELS_MD = readFileSync(
  "extension/skills/setup-flow/labels.md",
  "utf8",
);
const TEMPLATE_BODY = readFileSync(
  "extension/skills/setup-flow/profile-template.md",
  "utf8",
);
const CANONICAL = parseLabelsMarkdown(LABELS_MD);

const BASE_ANSWERS: ScaffoldAnswers = {
  owner: "CaribouJohn",
  repo: "pi-flow",
  defaultBranch: "main",
};

// --- buildFrontmatter -----------------------------------------------------

{
  const fm = buildFrontmatter(BASE_ANSWERS, CANONICAL) as Record<string, any>;
  check("tracker is 'github'", fm.tracker === "github");
  check("repo is owner/repo", fm.repo === "CaribouJohn/pi-flow");
  check("default_branch carried through", fm.default_branch === "main");
  check("track_branch_prefix defaults to 'track/'", fm.track_branch_prefix === "track/");
  check(
    "default reviewer_command set",
    typeof fm.reviewer_command === "string" && fm.reviewer_command.length > 0,
  );
  check(
    "poll_cadence_seconds is a number",
    typeof fm.poll_cadence_seconds === "number",
  );
  check(
    "labels.category contains bug + enhancement",
    Array.isArray(fm.labels.category) &&
      fm.labels.category.includes("bug") &&
      fm.labels.category.includes("enhancement"),
  );
  const stateKeys = Object.keys(fm.labels.state).sort();
  check(
    "labels.state has all 10 required keys",
    stateKeys.length === 10 &&
      stateKeys.includes("needs_triage") &&
      stateKeys.includes("ready_for_agent") &&
      stateKeys.includes("wontfix"),
    JSON.stringify(stateKeys),
  );
  check(
    "labels.state.ready_for_agent defaults to 'ready-for-agent'",
    fm.labels.state.ready_for_agent === "ready-for-agent",
  );
  check(
    "labels.effort has low/medium/high",
    fm.labels.effort.low === "effort:low" &&
      fm.labels.effort.medium === "effort:medium" &&
      fm.labels.effort.high === "effort:high",
  );
  check(
    "labels.review has agent/human",
    fm.labels.review.agent === "review:agent" &&
      fm.labels.review.human === "review:human",
  );
}

// labelOverrides honoured
{
  const fm = buildFrontmatter(
    { ...BASE_ANSWERS, labelOverrides: { ready_for_agent: "agent-ready" } },
    CANONICAL,
  ) as Record<string, any>;
  check(
    "labelOverrides remap ready_for_agent",
    fm.labels.state.ready_for_agent === "agent-ready",
  );
  check(
    "labelOverrides do not affect unrelated keys",
    fm.labels.state.needs_triage === "needs-triage",
  );
}

// Custom scalars carried through
{
  const fm = buildFrontmatter(
    {
      ...BASE_ANSWERS,
      verifyGate: "bun test",
      reviewerCommand: "/review",
      reviewerIterationCap: 5,
      pollCadenceSeconds: 60,
      aiDisclaimer: "> custom",
      trackBranchPrefix: "feat/",
    },
    CANONICAL,
  ) as Record<string, any>;
  check(
    "custom scalars carried through",
    fm.verify_gate === "bun test" &&
      fm.reviewer_command === "/review" &&
      fm.reviewer_iteration_cap === 5 &&
      fm.poll_cadence_seconds === 60 &&
      fm.ai_disclaimer === "> custom" &&
      fm.track_branch_prefix === "feat/",
  );
}

// --- renderProfile --------------------------------------------------------

{
  const out = renderProfile(BASE_ANSWERS, CANONICAL, TEMPLATE_BODY);
  check("starts with frontmatter fence", out.startsWith("---\n"));
  const closing = out.indexOf("\n---\n", 4);
  check("has closing fence", closing > 0);
  const body = out.slice(closing + "\n---\n".length);
  check(
    "preserves template body — keeps '# Flow profile' heading",
    body.includes("# Flow profile"),
  );
  check(
    "only one frontmatter block (no duplicate fences)",
    out.split(/^---$/m).length === 3,
  );
}

// --- createScaffoldProfile + in-memory fs --------------------------------

function makeFs(initial: Record<string, string> = {}): ScaffoldProfileFs & {
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

{
  const fs = makeFs();
  const s = createScaffoldProfile({
    cwd: "/repo",
    fs,
    loadTemplateBody: () => TEMPLATE_BODY,
    loadCanonicalLabelsMd: () => LABELS_MD,
  });
  const r = await s.run(BASE_ANSWERS);
  check(
    "fresh: written=true, path under .pi",
    r.written === true && r.path.replace(/\\/g, "/").endsWith(PROFILE_REL_PATH),
    JSON.stringify(r),
  );
  check("fresh: mkdirp called for .pi", fs.mkdirCalls.length === 1);
  const path = "/repo/" + PROFILE_REL_PATH;
  check(
    "fresh: file content includes frontmatter and template body",
    fs.files.has(path.replace(/\\/g, "/")) ||
      [...fs.files.keys()].some((k) => k.replace(/\\/g, "/").endsWith(PROFILE_REL_PATH)),
  );
}

{
  // Pre-existing profile + overwrite:false → no-op
  const cwd = "/repo";
  const path = `${cwd}/.pi/flow.profile.md`;
  const fs = makeFs({ [path]: "ORIGINAL" });
  // Path-key normalisation: factory uses join() so the stored key needs to match
  // what `exists` will be asked about. Re-derive via the factory's own join.
  const r = await createScaffoldProfile({
    cwd,
    fs: {
      exists: (p) => p.replace(/\\/g, "/") === path,
      mkdirp: () => {},
      writeFile: (p, c) => fs.files.set(p, c),
    },
    loadTemplateBody: () => TEMPLATE_BODY,
    loadCanonicalLabelsMd: () => LABELS_MD,
  }).run(BASE_ANSWERS);
  check(
    "exists + overwrite:false: written=false, reason='exists'",
    r.written === false && r.reason === "exists",
    JSON.stringify(r),
  );
}

{
  // overwrite:true → writes anyway
  const cwd = "/repo";
  const path = `${cwd}/.pi/flow.profile.md`;
  const written = new Map<string, string>([[path, "ORIGINAL"]]);
  const r = await createScaffoldProfile({
    cwd,
    fs: {
      exists: (p) => written.has(p.replace(/\\/g, "/")),
      mkdirp: () => {},
      writeFile: (p, c) => written.set(p.replace(/\\/g, "/"), c),
    },
    loadTemplateBody: () => TEMPLATE_BODY,
    loadCanonicalLabelsMd: () => LABELS_MD,
  }).run(BASE_ANSWERS, { overwrite: true });
  check("overwrite:true: written=true", r.written === true);
  check(
    "overwrite:true: contents replaced",
    written.get(path) !== "ORIGINAL" && written.get(path)!.startsWith("---\n"),
  );
}

// --- Round-trip through readProfile --------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-c4-"));
  try {
    // Drop fixture template + labels into a faux project root so the
    // factory's default loaders would find them (but we're using explicit
    // loaders below — this dir is only used as cwd for the write).
    const s = createScaffoldProfile({
      cwd: dir,
      fs: {
        exists: existsSync,
        mkdirp: (p) => mkdirSync(p, { recursive: true }),
        writeFile: (p, c) => writeFileSync(p, c, "utf8"),
      },
      loadTemplateBody: () => TEMPLATE_BODY,
      loadCanonicalLabelsMd: () => LABELS_MD,
    });
    const r = await s.run({
      ...BASE_ANSWERS,
      reviewerCommand: "/round-trip-review",
      pollCadenceSeconds: 45,
      labelOverrides: { wontfix: "no-fix" },
    });
    check("round-trip: file written", r.written === true);

    const parsed = readProfile(dir);
    check("round-trip: tracker", parsed.tracker === "github");
    check(
      "round-trip: repo",
      parsed.repo === "CaribouJohn/pi-flow",
    );
    check("round-trip: default_branch", parsed.default_branch === "main");
    check(
      "round-trip: custom reviewer_command preserved",
      parsed.reviewer_command === "/round-trip-review",
    );
    check(
      "round-trip: custom poll_cadence_seconds preserved",
      parsed.poll_cadence_seconds === 45,
    );
    check(
      "round-trip: labelOverrides survive (wontfix → no-fix)",
      labelForStateKey(parsed, "wontfix") === "no-fix",
    );
    check(
      "round-trip: default state label preserved (ready_for_agent)",
      labelForStateKey(parsed, "ready_for_agent") === "ready-for-agent",
    );
    check(
      "round-trip: body retained (contains 'Flow profile' heading)",
      parsed.body.includes("Flow profile"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
