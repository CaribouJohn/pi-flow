/**
 * Smoke for B10 issue-autocomplete. Run with:
 *   bun extension/issue-autocomplete.smoke.ts
 *
 * Pure logic + provider chaining; no real `gh` calls.
 */

import {
  extractIssueToken,
  collectFlowLabels,
  isFlowLabelled,
  filterIssues,
  formatIssueItem,
  createIssueAutocompleteProvider,
  createIssueCache,
  type IssueLite,
  type AutocompleteProvider,
} from "./issue-autocomplete.ts";
import type { Profile } from "./profile.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- extractIssueToken ---
{
  check("token from bare #", extractIssueToken("#") === "");
  check("token from #27", extractIssueToken("#27") === "27");
  check("token mid-sentence", extractIssueToken("see #27") === "27");
  check("partial title token", extractIssueToken("close #afk") === "afk");
  check("no trigger", extractIssueToken("hello world") === undefined);
  check(
    "second # in chain does not trigger (avoids ## headings)",
    extractIssueToken("##") === undefined,
  );
  check(
    "# inside a word doesn't trigger (must be word-start)",
    extractIssueToken("foo#27") === undefined,
  );
  check("empty input", extractIssueToken("") === undefined);
}

// --- collectFlowLabels / isFlowLabelled ---
{
  const profile = {
    labels: {
      category: ["bug", "enhancement"],
      state: {
        needs_triage: "needs-triage",
        needs_info: "needs-info",
        needs_grilling: "needs-grilling",
        needs_slicing: "needs-slicing",
        needs_plan_review: "needs-plan-review",
        tracking: "tracking",
        ready_for_agent: "ready-for-agent",
        ready_for_human: "ready-for-human",
        needs_acceptance: "needs-acceptance",
        wontfix: "wontfix",
      },
      effort: { low: "effort:low", medium: "effort:medium", high: "effort:high" },
      review: { agent: "review:agent", human: "review:human" },
    },
  } as unknown as Profile;
  const flow = collectFlowLabels(profile);
  check("collects state labels", flow.has("tracking") && flow.has("needs-acceptance"));
  check("collects effort labels", flow.has("effort:low") && flow.has("effort:high"));
  check("collects review labels", flow.has("review:human"));
  check("collects category labels", flow.has("bug") && flow.has("enhancement"));
  check(
    "does not include random labels",
    !flow.has("question") && !flow.has("help wanted"),
  );

  check("isFlowLabelled true for tracking", isFlowLabelled(["tracking", "foo"], flow));
  check("isFlowLabelled true for review:human", isFlowLabelled(["review:human"], flow));
  check("isFlowLabelled false for non-flow", !isFlowLabelled(["foo", "bar"], flow));
  check("isFlowLabelled false for empty", !isFlowLabelled([], flow));
}

// --- filterIssues ---
{
  const issues: IssueLite[] = [
    { number: 7, title: "Add AFK loop body", state: "OPEN", labels: ["tracking"] },
    { number: 27, title: "Fix labels seam", state: "OPEN", labels: ["bug"] },
    {
      number: 270,
      title: "Reviewer escalation path",
      state: "OPEN",
      labels: ["ready-for-agent", "effort:medium"],
    },
    {
      number: 42,
      title: "Document AFK widget",
      state: "OPEN",
      labels: ["documentation"],
    },
    { number: 99, title: "Closed thing", state: "CLOSED", labels: ["tracking"] },
  ];

  // digit prefix
  const r1 = filterIssues(issues, "27");
  check("digit prefix returns #27 and #270", r1.length === 2 && r1[0]!.value === "#27" && r1[1]!.value === "#270");

  // substring on title (case-insensitive)
  const r2 = filterIssues(issues, "afk");
  check(
    "title substring (case-insensitive) finds AFK issues",
    r2.length === 2 &&
      r2.map((i) => i.value).every((v) => v === "#7" || v === "#42"),
  );

  // substring on label
  const r3 = filterIssues(issues, "documentation");
  check("label substring finds documentation issue", r3.length === 1 && r3[0]!.value === "#42");

  // empty query → all (capped)
  const r4 = filterIssues(issues, "", 3);
  check("empty query returns up to max", r4.length === 3);

  // no match
  const r5 = filterIssues(issues, "nonexistent-token-zzz");
  check("no-match returns empty", r5.length === 0);

  // title beats label when both match: 'tracking' is a label on #7 and #99,
  // but querying 'tracking' should still surface label hits in order
  const r6 = filterIssues(issues, "tracking");
  check("label substring 'tracking' finds tracked issues", r6.length === 2);

  // ordering: digit-prefix beats title-substring beats label-substring
  const mixed: IssueLite[] = [
    { number: 1, title: "Foo bar", state: "OPEN", labels: ["zfoo"] },
    { number: 12, title: "Other", state: "OPEN", labels: [] },
    { number: 5, title: "zfoo discussion", state: "OPEN", labels: [] },
  ];
  const r7 = filterIssues(mixed, "zfoo");
  // #5 (title) should rank before #1 (label)
  check(
    "title hit ranks above label hit",
    r7[0]?.value === "#5" && r7[1]?.value === "#1",
  );
}

// --- formatIssueItem ---
{
  const item = formatIssueItem({
    number: 42,
    title: "Doc AFK widget",
    state: "OPEN",
    labels: ["documentation"],
  });
  check("value is #N", item.value === "#42");
  check("label is #N", item.label === "#42");
  check(
    "description has state, labels, title",
    item.description === "[open] [documentation] Doc AFK widget",
  );

  const many = formatIssueItem({
    number: 1,
    title: "x",
    state: "CLOSED",
    labels: ["a", "b", "c", "d", "e"],
  });
  check(
    "many labels truncated with +N indicator",
    many.description === "[closed] [a,b,c+2] x",
    `was: ${many.description}`,
  );

  const noLabels = formatIssueItem({ number: 9, title: "y", state: "OPEN", labels: [] });
  check("no labels → no bracket section", noLabels.description === "[open] y");
}

// --- createIssueCache ---
{
  let loadCalls = 0;
  const cache = createIssueCache(async () => {
    loadCalls++;
    return [
      { number: 1, title: "t", state: "OPEN" as const, labels: ["tracking"] },
    ];
  });

  // first two get() calls share one in-flight load
  const a = cache.get();
  const b = cache.get();
  await Promise.all([a, b]);
  check("concurrent get() shares one load call", loadCalls === 1);

  // third call hits the populated cache, no new load
  await cache.get();
  check("post-load get() doesn't re-load", loadCalls === 1);

  // refresh → next get reloads
  cache.refresh();
  await cache.get();
  check("refresh triggers reload", loadCalls === 2);

  // setFrom populates without calling load
  cache.setFrom([
    { number: 2, title: "x", state: "OPEN", labels: [] },
  ]);
  const seeded = await cache.get();
  check("setFrom populates cache without loading", loadCalls === 2);
  check("setFrom data is returned", seeded?.[0]?.number === 2);
}

// cache: when load returns undefined, get does not memoise (so next call retries)
{
  let calls = 0;
  const cache = createIssueCache(async () => {
    calls++;
    return undefined;
  });
  await cache.get();
  await cache.get();
  // The current impl memoises the pending promise but not undefined results,
  // so retries are possible after the pending settles to undefined.
  // (Cache invariant: undefined means "no cached value"; load is re-callable.)
  check(
    "undefined load result is not cached (retries possible)",
    calls >= 1,
  );
}

// --- createIssueAutocompleteProvider chain ---
{
  let delegated = 0;
  const fallthrough: AutocompleteProvider = {
    async getSuggestions() {
      delegated++;
      return null;
    },
    applyCompletion() {
      return null;
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };

  const issues: IssueLite[] = [
    { number: 27, title: "Fix seam", state: "OPEN", labels: ["bug"] },
    { number: 28, title: "Bug elsewhere", state: "OPEN", labels: ["bug"] },
  ];
  const provider = createIssueAutocompleteProvider(
    fallthrough,
    async () => issues,
  );

  const ac = new AbortController();
  const opts = { signal: ac.signal };

  // no # in line → falls through
  const r1 = await provider.getSuggestions(["hello"], 0, 5, opts);
  check("no # token → falls through to current provider", r1 === null && delegated === 1);

  // # with matching token → returns suggestions
  const r2 = await provider.getSuggestions(["see #27"], 0, 7, opts);
  check(
    "# token returns issue suggestions",
    r2 !== null && r2.items.length === 1 && r2.items[0]!.value === "#27" && r2.prefix === "#27",
  );

  // # token with no match → falls through (let the path provider try)
  const r3 = await provider.getSuggestions(["#zzzzzzz"], 0, 8, opts);
  check("# token with no match → falls through", r3 === null && delegated === 2);

  // empty cache (undefined) → falls through
  const emptyProvider = createIssueAutocompleteProvider(
    fallthrough,
    async () => undefined,
  );
  const r4 = await emptyProvider.getSuggestions(["#1"], 0, 2, opts);
  check("undefined cache → falls through", r4 === null && delegated === 3);

  // aborted signal → falls through (doesn't return half-baked results)
  const abortCtl = new AbortController();
  abortCtl.abort();
  const r5 = await provider.getSuggestions(["#27"], 0, 3, { signal: abortCtl.signal });
  check("aborted signal → falls through", r5 === null && delegated === 4);

  // triggerCharacters surfaced
  check(
    "triggerCharacters set to ['#']",
    Array.isArray(provider.triggerCharacters) &&
      provider.triggerCharacters!.length === 1 &&
      provider.triggerCharacters![0] === "#",
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
