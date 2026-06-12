/**
 * Preflight for `/flow setup` (C1). The deterministic check that the wizard
 * — and any other tool that wants to fail fast — can run before touching
 * GitHub or the working tree.
 *
 * Does two things:
 *   - `gh auth status` (host = github.com) — captures the authed user.
 *   - `git remote get-url origin` → parses `{owner, repo}` from the URL.
 *
 * Pure read-only; no mutation-registry token needed.
 *
 * The exec seam (`PreflightRun`) is injectable so the smoke test can drive
 * the result-assembly logic without spawning processes. Production wires
 * `pi.exec` in via `createPreflightFromPi`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PreflightErrorCode =
  | "gh_not_authed"
  | "no_origin"
  | "unparseable_remote";

export type PreflightError = {
  code: PreflightErrorCode;
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  ghAuthed: boolean;
  ghUser?: string;
  owner?: string;
  repo?: string;
  errors: PreflightError[];
};

export type PreflightRun = (
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type Preflight = {
  run(opts?: { signal?: AbortSignal }): Promise<PreflightResult>;
};

/**
 * Parse an `origin` remote URL into `{owner, repo}`.
 *
 * Accepts the three forms `git remote get-url` actually emits for a GitHub
 * remote: SSH (`git@github.com:owner/repo.git`), HTTPS
 * (`https://github.com/owner/repo.git`), and `ssh://` URL form
 * (`ssh://git@github.com/owner/repo.git`). The trailing `.git` is
 * optional. Returns null for anything that doesn't match — the caller
 * surfaces that as `unparseable_remote`.
 *
 * Only github.com is recognised (the only tracker pi-flow supports today
 * per DESIGN.md). GitHub Enterprise hosts are intentionally rejected here
 * so we don't half-support them; that's a separate slice if it's ever
 * needed.
 */
export function parseOriginRemote(
  url: string,
): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // SSH scp-like: git@github.com:owner/repo(.git)?
  const scp = trimmed.match(
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (scp) return { owner: scp[1]!, repo: scp[2]! };

  // ssh:// or https:// URLs
  const url2 = trimmed.match(
    /^(?:ssh:\/\/git@|https:\/\/(?:[^@/]+@)?)github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (url2) return { owner: url2[1]!, repo: url2[2]! };

  return null;
}

/**
 * Pull a username out of `gh auth status` output. gh writes the status to
 * stderr historically and to stdout in newer versions, so we check both.
 * The line we want looks like `Logged in to github.com account NAME (...)`.
 */
function extractGhUser(stdout: string, stderr: string): string | undefined {
  const both = `${stderr}\n${stdout}`;
  const m = both.match(/Logged in to github\.com\s+account\s+(\S+)/);
  return m ? m[1] : undefined;
}

export function createPreflight(deps: { run: PreflightRun }): Preflight {
  return {
    async run(opts = {}): Promise<PreflightResult> {
      const errors: PreflightError[] = [];

      // --- gh auth status ---
      let ghAuthed = false;
      let ghUser: string | undefined;
      try {
        const r = await deps.run(
          "gh",
          ["auth", "status", "--hostname", "github.com"],
          { signal: opts.signal },
        );
        if (r.code === 0) {
          ghAuthed = true;
          ghUser = extractGhUser(r.stdout, r.stderr);
        } else {
          errors.push({
            code: "gh_not_authed",
            message: `gh is not authenticated for github.com (exit ${r.code}). Run 'gh auth login'.`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          code: "gh_not_authed",
          message: `Could not run 'gh auth status': ${msg}. Install gh and ensure it's on PATH, then run 'gh auth login'.`,
        });
      }

      // --- git remote get-url origin ---
      let owner: string | undefined;
      let repo: string | undefined;
      try {
        const r = await deps.run(
          "git",
          ["remote", "get-url", "origin"],
          { signal: opts.signal },
        );
        if (r.code !== 0) {
          errors.push({
            code: "no_origin",
            message: `No 'origin' remote is configured (git exit ${r.code}). Add one with 'git remote add origin <url>'.`,
          });
        } else {
          const parsed = parseOriginRemote(r.stdout);
          if (!parsed) {
            errors.push({
              code: "unparseable_remote",
              message: `Could not parse origin remote URL '${r.stdout.trim()}' as a github.com repository. pi-flow only supports github.com today.`,
            });
          } else {
            owner = parsed.owner;
            repo = parsed.repo;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          code: "no_origin",
          message: `Could not run 'git remote get-url origin': ${msg}. Is git installed and is this a git repository?`,
        });
      }

      return {
        ok: errors.length === 0,
        ghAuthed,
        ghUser,
        owner,
        repo,
        errors,
      };
    },
  };
}

/**
 * Production wiring: build a `Preflight` backed by `pi.exec`. Kept tiny so
 * the testable surface stays in `createPreflight`.
 */
export function createPreflightFromPi(pi: ExtensionAPI): Preflight {
  const run: PreflightRun = async (bin, args, opts) => {
    const r = await pi.exec(bin, args, { signal: opts?.signal });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  };
  return createPreflight({ run });
}
