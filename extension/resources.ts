/**
 * Helpers for resources (skill prompts, templates, snippets) shipped
 * alongside the extension under `extension/skills/`.
 *
 * `discover` returns the relative paths of every file under that root,
 * optionally scoped to a single skill subdirectory. Use this when an LLM
 * needs to know what guidance is available before reading any single file.
 *
 * No I/O beyond `fs.readdirSync` walks; pure-ish (filesystem-dependent).
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

function walk(root: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export type DiscoverOpts = { skill?: string };

export function skillsRoot(cwd: string): string {
  return join(cwd, "extension", "skills");
}

export function discover(cwd: string, opts: DiscoverOpts = {}): string[] {
  const root = opts.skill
    ? join(skillsRoot(cwd), opts.skill)
    : skillsRoot(cwd);
  const files = walk(root);
  // Return relative-to-cwd paths with forward slashes for cross-platform consistency.
  return files
    .map((f) => relative(cwd, f).split(sep).join("/"))
    .sort();
}
