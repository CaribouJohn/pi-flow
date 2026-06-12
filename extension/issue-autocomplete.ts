/**
 * B10 — `#NNN` issue-number autocomplete.
 *
 * Pure pieces (filter, format, label-union derivation) plus a thin
 * `AutocompleteProvider` factory that chains on top of pi's built-in
 * provider. The wiring (one `gh issue list` on session start, optional
 * future refresh from the poller) lives in `index.ts`.
 *
 * Pi's autocomplete types live in `@earendil-works/pi-tui`; pi-flow
 * does not depend on pi-tui directly. We define the minimal shape we
 * need here as a local structural type — duck-typed when registered
 * via `ctx.ui.addAutocompleteProvider(...)`.
 */

import type { Profile } from "./profile.ts";

// --- minimal local shape of pi-tui's autocomplete types --------------

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

export type AutocompleteSuggestions = {
  items: AutocompleteItem[];
  prefix: string;
};

export type AutocompleteOptions = {
  signal: AbortSignal;
};

export type AutocompleteProvider = {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: AutocompleteOptions,
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): unknown;
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
};

// --- domain types ----------------------------------------------------

export type IssueLite = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
};

export const DEFAULT_MAX_SUGGESTIONS = 20;

// --- pure helpers ----------------------------------------------------

/**
 * Pull the bare token after `#` immediately before the cursor.
 *
 * Returns the token text (may be empty `""`) when the cursor is on a
 * `#`-prefixed run, or `undefined` if there's no `#` trigger. Matches
 * pi's documented autocomplete `triggerCharacters: ["#"]` shape.
 */
export function extractIssueToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
  return match?.[1];
}

/**
 * Union of every label the flow profile reserves — the membership
 * predicate for "this is a flow-owned issue". Includes state labels,
 * effort labels, review labels, and category labels.
 */
export function collectFlowLabels(profile: Profile): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(profile.labels.state)) out.add(v);
  for (const v of Object.values(profile.labels.effort)) out.add(v);
  for (const v of Object.values(profile.labels.review)) out.add(v);
  for (const v of profile.labels.category) out.add(v);
  return out;
}

/** True if the issue carries at least one flow label. */
export function isFlowLabelled(
  labels: string[],
  flowLabels: Set<string>,
): boolean {
  for (const l of labels) if (flowLabels.has(l)) return true;
  return false;
}

/**
 * Tiny fuzzy/substring matcher. We deliberately do NOT pull in
 * `pi-tui`'s `fuzzyFilter` — keeping the dependency surface flat is
 * worth the loss of subsequence matching for what is essentially a
 * "user typed a few characters of an issue title" use case.
 *
 * Scoring (lower is better):
 *   0  : exact prefix on number
 *   1  : substring on number
 *   2  : substring on title (case-insensitive)
 *   3  : substring on a label (case-insensitive)
 */
function scoreIssue(issue: IssueLite, q: string): number | null {
  if (!q) return 4; // surface everything, push to back so order stays stable
  const lq = q.toLowerCase();
  const numStr = String(issue.number);
  if (numStr.startsWith(q)) return 0;
  if (numStr.includes(q)) return 1;
  if (issue.title.toLowerCase().includes(lq)) return 2;
  for (const l of issue.labels) {
    if (l.toLowerCase().includes(lq)) return 3;
  }
  return null;
}

export function filterIssues(
  issues: IssueLite[],
  query: string,
  max: number = DEFAULT_MAX_SUGGESTIONS,
): AutocompleteItem[] {
  const q = query.trim();
  const scored: Array<{ issue: IssueLite; score: number; idx: number }> = [];
  issues.forEach((issue, idx) => {
    const s = scoreIssue(issue, q);
    if (s !== null) scored.push({ issue, score: s, idx });
  });
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.slice(0, max).map((s) => formatIssueItem(s.issue));
}

export function formatIssueItem(issue: IssueLite): AutocompleteItem {
  const state = issue.state.toLowerCase();
  // Truncate visible labels so the completer row stays readable in
  // narrow terminals; the user is matching, not reading a manifest.
  const visible = issue.labels.slice(0, 3).join(",");
  const more = issue.labels.length > 3 ? `+${issue.labels.length - 3}` : "";
  const labelTag = visible ? ` [${visible}${more}]` : "";
  return {
    value: `#${issue.number}`,
    label: `#${issue.number}`,
    description: `[${state}]${labelTag} ${issue.title}`,
  };
}

// --- provider factory ------------------------------------------------

/**
 * Wrap pi's current autocomplete provider so `#...` tokens hit the
 * issue cache and everything else passes through unchanged.
 *
 * `getIssues` is async + nullable to allow the wiring layer to do a
 * lazy first-load on `session_start` and to return `undefined` on
 * cache-miss / gh failure (in which case we silently fall through).
 */
export function createIssueAutocompleteProvider(
  current: AutocompleteProvider,
  getIssues: () => Promise<IssueLite[] | undefined>,
): AutocompleteProvider {
  return {
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const token = extractIssueToken(textBeforeCursor);
      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const issues = await getIssues();
      if (options.signal.aborted || !issues || issues.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const suggestions = filterIssues(issues, token);
      if (suggestions.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        items: suggestions,
        prefix: `#${token}`,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

// --- cache helper for the wiring layer -------------------------------

/**
 * A tiny mutable cache the wiring layer uses to feed the provider.
 *
 * - `get()` is lazy: first call kicks off `load()`; subsequent calls
 *   return the same promise until something replaces it.
 * - `refresh()` forces a reload on the next `get()`.
 * - `setFrom(issues)` lets the (future) B9 poller wiring shove a fresh
 *   snapshot in without spending an extra `gh` call.
 */
export type IssueCache = {
  get(): Promise<IssueLite[] | undefined>;
  refresh(): void;
  setFrom(issues: IssueLite[]): void;
};

export function createIssueCache(
  load: () => Promise<IssueLite[] | undefined>,
): IssueCache {
  let pending: Promise<IssueLite[] | undefined> | undefined;
  let cached: IssueLite[] | undefined;
  return {
    get() {
      if (cached) return Promise.resolve(cached);
      pending ||= (async () => {
        const result = await load();
        if (result) cached = result;
        return result;
      })();
      return pending;
    },
    refresh() {
      cached = undefined;
      pending = undefined;
    },
    setFrom(issues) {
      cached = issues;
      pending = undefined;
    },
  };
}
