/**
 * `setup_flow_apply_issue_templates` (C3). Copies the bundled GitHub
 * issue-form YAMLs from `extension/skills/setup-flow/issue-templates/` to
 * `.github/ISSUE_TEMPLATE/` in the user's repo, so contributors and AFK
 * agents file structured issues out of the box.
 *
 * No commit — files are left in the working tree for the user to inspect
 * and commit themselves. (Same convention as `setup_flow_scaffold_profile`
 * and the rest of the wizard.)
 *
 * The factory takes a `loadBundled` thunk and an `fs` seam so the smoke
 * test exercises the copy / overwrite / skip logic against an in-memory
 * filesystem without touching disk.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** A bundled template, identified by its destination filename. */
export type BundledTemplate = {
  /** File name written under `.github/ISSUE_TEMPLATE/`, e.g. `triage.yml`. */
  name: string;
  /** Raw YAML contents. */
  contents: string;
};

export type ApplyTemplatesResult = {
  written: string[];
  skippedExisting: string[];
};

export type SetupTemplatesFs = {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  writeFile(path: string, contents: string): void;
};

export type SetupTemplates = {
  apply(opts?: { overwrite?: boolean }): Promise<ApplyTemplatesResult>;
};

/** The canonical destination directory, relative to a repo root. */
export const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

export function createSetupTemplates(deps: {
  /** Returns all bundled templates, in deterministic (sorted) order. */
  loadBundled: () => BundledTemplate[];
  /** Repo root. Destinations are resolved relative to this. */
  cwd: string;
  fs: SetupTemplatesFs;
}): SetupTemplates {
  return {
    async apply(opts = {}) {
      const bundled = deps.loadBundled();
      if (bundled.length === 0) {
        throw new Error(
          "setup_flow_apply_issue_templates: no bundled templates found. " +
            "Check `extension/skills/setup-flow/issue-templates/` ships .yml files.",
        );
      }

      const destDir = join(deps.cwd, ISSUE_TEMPLATE_DIR);
      deps.fs.mkdirp(destDir);

      const written: string[] = [];
      const skippedExisting: string[] = [];

      for (const t of bundled) {
        const destPath = join(destDir, t.name);
        if (deps.fs.exists(destPath) && !opts.overwrite) {
          skippedExisting.push(t.name);
          continue;
        }
        deps.fs.writeFile(destPath, t.contents);
        written.push(t.name);
      }

      return { written, skippedExisting };
    },
  };
}

// --- Production wiring ----------------------------------------------------

/**
 * Returns the directory where the bundled templates live, alongside the
 * other `setup-flow` skill resources. Resolved against the user's repo
 * cwd (same convention as `resources.ts`).
 */
export function bundledTemplatesDir(cwd: string): string {
  return join(cwd, "extension", "skills", "setup-flow", "issue-templates");
}

export function defaultLoadBundled(cwd: string): () => BundledTemplate[] {
  return () => {
    const dir = bundledTemplatesDir(cwd);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `setup_flow_apply_issue_templates: could not read bundled templates from ${dir}: ${msg}.`,
      );
    }
    return entries
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
      .sort()
      .map((name) => ({ name, contents: readFileSync(join(dir, name), "utf8") }));
  };
}

export function defaultFs(): SetupTemplatesFs {
  return {
    exists: (p) => existsSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
  };
}
