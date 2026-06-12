/**
 * `setup_flow_apply_labels` (C2). Reads the canonical label vocabulary
 * from `extension/skills/setup-flow/labels.md`, diffs against the repo's
 * current labels, and creates anything missing via `gh label create`.
 *
 * Strict no-edit / no-delete policy: an existing label name is reported
 * as `alreadyPresent` regardless of whether its colour or description
 * match the canonical row. Mismatches are surfaced to the caller but
 * never auto-corrected — labels often get hand-tuned and silently
 * stomping them would be hostile. (Fixing drift is a future slice, if
 * ever needed.)
 *
 * Pure parser (`parseLabelsMarkdown`) is exported so the smoke test
 * exercises it without filesystem I/O. The factory takes a `Gh` and a
 * `loadCanonical` thunk so the smoke test can supply both.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gh } from "./gh.ts";
import { GhError } from "./gh.ts";

export type LabelSpec = {
  name: string;
  color: string; // 6-char hex, no leading '#'
  description: string;
};

export type ApplyLabelsResult = {
  created: string[];
  alreadyPresent: string[];
  skippedDueToDryRun: string[];
  /**
   * Existing labels whose colour or description diverges from the
   * canonical row. Reported, never auto-corrected.
   */
  drift: Array<{
    name: string;
    canonical: { color: string; description: string };
    actual: { color: string; description: string };
  }>;
};

export type SetupLabels = {
  apply(opts?: {
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<ApplyLabelsResult>;
};

const HEX6 = /^[0-9a-fA-F]{6}$/;

/**
 * Parse the canonical labels markdown. Accepts any number of GitHub-Flavoured
 * pipe tables; reads every row whose first cell is a backticked label name.
 * The header / separator rows are skipped by the cell-shape filter (their
 * first cell isn't a backticked identifier).
 *
 * Throws if the file declares the same label name twice, or if a row's
 * colour cell isn't 6 hex digits — both indicate a hand-edit bug we'd
 * rather catch loudly at parse time than silently apply.
 */
export function parseLabelsMarkdown(md: string): LabelSpec[] {
  const out: LabelSpec[] = [];
  const seen = new Set<string>();

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;

    // Split, drop the empty edges produced by leading/trailing pipes.
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const nameCell = cells[0]!;
    const colorCell = cells[1]!;
    const descCell = cells[2]!;

    // First cell must look like `\`name\`` — that's how every row is
    // formatted, and it filters out the header (`Name`) and separator
    // (`---`) rows in one move.
    const nameMatch = nameCell.match(/^`([^`]+)`$/);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;

    if (!HEX6.test(colorCell)) {
      throw new Error(
        `labels.md: row for '${name}' has invalid colour '${colorCell}' (expected 6-char hex).`,
      );
    }

    if (seen.has(name)) {
      throw new Error(`labels.md: duplicate label '${name}'.`);
    }
    seen.add(name);

    out.push({ name, color: colorCell.toLowerCase(), description: descCell });
  }

  if (out.length === 0) {
    throw new Error(
      "labels.md: no label rows parsed. Expected `\\`name\\` | hex | description` pipe-table rows.",
    );
  }
  return out;
}

type RawLabel = { name: string; color?: string; description?: string };

export function createSetupLabels(deps: {
  gh: Gh;
  loadCanonical: () => string;
}): SetupLabels {
  return {
    async apply(opts = {}) {
      const canonical = parseLabelsMarkdown(deps.loadCanonical());

      // Pull current label set from the repo. We ask for the same fields
      // we plan to compare, so drift detection is one pass.
      const listRes = await deps.gh.run(
        ["label", "list", "--json", "name,color,description", "--limit", "200"],
        { signal: opts.signal },
      );
      if (listRes.code !== 0) {
        throw new GhError(
          `gh label list exited ${listRes.code}: ${listRes.stderr.trim()}`,
          listRes.code,
          listRes.stderr,
        );
      }
      let existing: RawLabel[];
      try {
        const parsed = JSON.parse(listRes.stdout);
        if (!Array.isArray(parsed)) throw new Error("expected array");
        existing = parsed as RawLabel[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new GhError(
          `gh label list: invalid JSON: ${msg}`,
          0,
          listRes.stdout.slice(0, 500),
        );
      }
      const byName = new Map<string, RawLabel>();
      for (const l of existing) byName.set(l.name, l);

      const created: string[] = [];
      const alreadyPresent: string[] = [];
      const skippedDueToDryRun: string[] = [];
      const drift: ApplyLabelsResult["drift"] = [];

      for (const spec of canonical) {
        const cur = byName.get(spec.name);
        if (cur) {
          alreadyPresent.push(spec.name);
          const actualColor = (cur.color ?? "").toLowerCase();
          const actualDesc = cur.description ?? "";
          if (actualColor !== spec.color || actualDesc !== spec.description) {
            drift.push({
              name: spec.name,
              canonical: { color: spec.color, description: spec.description },
              actual: { color: actualColor, description: actualDesc },
            });
          }
          continue;
        }

        if (opts.dryRun) {
          skippedDueToDryRun.push(spec.name);
          continue;
        }

        const r = await deps.gh.run(
          [
            "label",
            "create",
            spec.name,
            "--color",
            spec.color,
            "--description",
            spec.description,
          ],
          { signal: opts.signal },
        );
        if (r.code !== 0) {
          throw new GhError(
            `gh label create '${spec.name}' exited ${r.code}: ${r.stderr.trim()}`,
            r.code,
            r.stderr,
          );
        }
        created.push(spec.name);
      }

      return { created, alreadyPresent, skippedDueToDryRun, drift };
    },
  };
}

/**
 * Production wiring: reads `extension/skills/setup-flow/labels.md`
 * relative to the project cwd (same convention as `resources.ts`).
 */
export function defaultLoadCanonical(cwd: string): () => string {
  const path = join(cwd, "extension", "skills", "setup-flow", "labels.md");
  return () => readFileSync(path, "utf8");
}
