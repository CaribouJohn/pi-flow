/**
 * Centralised `gh` CLI wrapper. All flow-extension code goes through this
 * module — never call `pi.exec("gh", ...)` from a tool directly. This is the
 * single seam for testing / future remote-execution operations.
 *
 * Returns parsed shapes typed in this module. Throws `GhError` (with exit
 * code + captured stderr) on any non-zero exit or JSON parse failure.
 *
 * A4 ships only what A4 needs (`listIssues`); subsequent slices grow the
 * module surface (A7 adds `editIssueLabels`, A8 adds `viewIssue`, A9 adds
 * `commentOnIssue`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GhIssueRef = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  body: string;
  updatedAt: string;
};

export type ListIssuesOpts = {
  labels?: string[];
  state?: "open" | "closed" | "all";
  limit?: number;
  /** Raw extra `gh issue list` flags (escape hatch). */
  extra?: string[];
  signal?: AbortSignal;
};

export class GhError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public stderr: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

export type Gh = {
  run(
    args: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  listIssues(opts?: ListIssuesOpts): Promise<GhIssueRef[]>;
};

type RawIssue = {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string }>;
  body?: string;
  updatedAt: string;
};

export function createGh(pi: ExtensionAPI): Gh {
  async function run(args: string[], opts: { signal?: AbortSignal } = {}) {
    let r: Awaited<ReturnType<typeof pi.exec>>;
    try {
      r = await pi.exec("gh", args, { signal: opts.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GhError(
        `gh failed to start: ${msg}. Is gh installed and on PATH?`,
        -1,
        "",
      );
    }
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  }

  async function listIssues(opts: ListIssuesOpts = {}): Promise<GhIssueRef[]> {
    const args = [
      "issue",
      "list",
      "--json",
      "number,title,state,labels,body,updatedAt",
    ];
    for (const l of opts.labels ?? []) args.push("-l", l);
    if (opts.state) args.push("--state", opts.state);
    if (opts.limit != null) args.push("--limit", String(opts.limit));
    if (opts.extra) args.push(...opts.extra);

    const r = await run(args, { signal: opts.signal });
    if (r.code !== 0) {
      throw new GhError(
        `gh issue list exited ${r.code}: ${r.stderr.trim()}`,
        r.code,
        r.stderr,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(r.stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GhError(
        `gh issue list: invalid JSON: ${msg}`,
        0,
        r.stdout.slice(0, 500),
      );
    }
    if (!Array.isArray(raw)) {
      throw new GhError(
        `gh issue list: expected JSON array, got ${typeof raw}`,
        0,
        "",
      );
    }
    return (raw as RawIssue[]).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state === "CLOSED" ? "CLOSED" : "OPEN",
      labels: (i.labels ?? []).map((l) => l.name),
      body: i.body ?? "",
      updatedAt: i.updatedAt,
    }));
  }

  return { run, listIssues };
}
