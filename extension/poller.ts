/**
 * `flow_poll` — one-tick GitHub snapshot + diff against a previous
 * snapshot. Pure: zero I/O beyond the injected `run` dep (the same
 * `{stdout, stderr, code}` shape `pi.exec` and `gh.run` return), so the
 * smoke stubs canned JSON.
 *
 * Two `gh` calls per tick:
 *   gh issue list --json number,labels,updatedAt,state,assignees -l <label>...
 *   gh pr list    --json number,state,closingIssuesReferences
 *
 * Issues are scoped to the union of all flow labels (caller passes them
 * in via `opts.labels`) so the poller's wide scope matches DESIGN.md
 * §AFK heartbeat — issues without a flow label are invisible.
 *
 * No scheduling here. The scheduler (B3) wraps this; the loop wiring
 * (B9) subscribes via the scheduler.
 */

export type IssueSnap = {
  number: number;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  updatedAt: string;
};

export type PRSnap = {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Issues this PR's body declared as closed (via `Closes #N` etc). */
  closingIssues: number[];
};

export type Snapshot = {
  issues: Map<number, IssueSnap>;
  prs: Map<number, PRSnap>;
  ts: number;
};

export type DiffKind =
  | "label-added"
  | "label-removed"
  | "opened"
  | "closed"
  | "pr-merged-closes";

export type Diff =
  | {
      kind: "label-added" | "label-removed";
      issue: number;
      label: string;
      ts: number;
    }
  | {
      kind: "opened" | "closed";
      issue: number;
      ts: number;
    }
  | {
      kind: "pr-merged-closes";
      pr: number;
      issue: number;
      ts: number;
    };

export type RunResult = { stdout: string; stderr: string; code: number };

export type PollDeps = {
  run(args: string[]): Promise<RunResult>;
  now?: () => number;
};

export type PollOpts = {
  /** Flow labels to scope `gh issue list` by. Pass the union of every flow
   * state label so the wide-scope rule holds (no flow issue is invisible). */
  labels: string[];
  /** Cap `gh issue list --limit`; defaults to 200. */
  issueLimit?: number;
};

/** Raw shapes returned by `gh --json` (only the fields we asked for). */
type RawIssue = {
  number: number;
  state: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  updatedAt: string;
};
type RawPR = {
  number: number;
  state: string;
  closingIssuesReferences?: Array<{ number: number }>;
};

export async function flowPoll(
  prev: Snapshot | null,
  deps: PollDeps,
  opts: PollOpts,
): Promise<{ snapshot: Snapshot; diffs: Diff[] }> {
  const now = (deps.now ?? Date.now)();
  const issueLimit = opts.issueLimit ?? 200;

  // --- gh issue list ---
  const issueArgs = [
    "issue",
    "list",
    "--json",
    "number,state,labels,updatedAt,assignees",
    "--state",
    "all",
    "--limit",
    String(issueLimit),
  ];
  for (const l of opts.labels) issueArgs.push("-l", l);

  const issueRes = await deps.run(issueArgs);
  if (issueRes.code !== 0) {
    throw new Error(
      `flow_poll: gh issue list exited ${issueRes.code}: ${issueRes.stderr.trim()}`,
    );
  }
  const rawIssues = safeParseArray(issueRes.stdout) as RawIssue[];

  const issues = new Map<number, IssueSnap>();
  for (const r of rawIssues) {
    issues.set(r.number, {
      number: r.number,
      state: r.state === "CLOSED" ? "CLOSED" : "OPEN",
      labels: (r.labels ?? []).map((l) => l.name),
      assignees: (r.assignees ?? []).map((a) => a.login),
      updatedAt: r.updatedAt,
    });
  }

  // --- gh pr list ---
  const prArgs = [
    "pr",
    "list",
    "--json",
    "number,state,closingIssuesReferences",
    "--state",
    "all",
    "--limit",
    String(issueLimit),
  ];
  const prRes = await deps.run(prArgs);
  if (prRes.code !== 0) {
    throw new Error(
      `flow_poll: gh pr list exited ${prRes.code}: ${prRes.stderr.trim()}`,
    );
  }
  const rawPrs = safeParseArray(prRes.stdout) as RawPR[];

  const prs = new Map<number, PRSnap>();
  for (const r of rawPrs) {
    prs.set(r.number, {
      number: r.number,
      state:
        r.state === "MERGED"
          ? "MERGED"
          : r.state === "CLOSED"
            ? "CLOSED"
            : "OPEN",
      closingIssues: (r.closingIssuesReferences ?? []).map((c) => c.number),
    });
  }

  const snapshot: Snapshot = { issues, prs, ts: now };
  const diffs = prev ? diffSnapshots(prev, snapshot, now) : [];
  return { snapshot, diffs };
}

function safeParseArray(stdout: string): unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`flow_poll: invalid JSON: ${msg}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`flow_poll: expected JSON array, got ${typeof raw}`);
  }
  return raw;
}

export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot,
  ts: number,
): Diff[] {
  const out: Diff[] = [];

  // --- issue diffs ---
  for (const [num, after] of next.issues) {
    const before = prev.issues.get(num);
    if (!before) {
      // New to the snapshot — only "opened" matters; CLOSED-on-arrival is
      // a no-op for us (no prior state to compare against).
      if (after.state === "OPEN") out.push({ kind: "opened", issue: num, ts });
      continue;
    }
    // State transitions
    if (before.state !== after.state) {
      out.push({
        kind: after.state === "OPEN" ? "opened" : "closed",
        issue: num,
        ts,
      });
    }
    // Label adds/removes — compare as sets
    const beforeLabels = new Set(before.labels);
    const afterLabels = new Set(after.labels);
    for (const l of afterLabels) {
      if (!beforeLabels.has(l)) {
        out.push({ kind: "label-added", issue: num, label: l, ts });
      }
    }
    for (const l of beforeLabels) {
      if (!afterLabels.has(l)) {
        out.push({ kind: "label-removed", issue: num, label: l, ts });
      }
    }
  }
  // Issues that dropped out of scope (e.g. lost their last flow label) we
  // do NOT synthesise diffs for — the next snapshot just won't include
  // them. The loop reads "needs human" from labels still present, so a
  // disappearing issue is correctly treated as "no longer our concern".

  // --- PR diffs: merge that closes a linked flow issue ---
  for (const [num, after] of next.prs) {
    const before = prev.prs.get(num);
    if (!before) continue; // never seen — can't have just transitioned
    if (before.state !== "MERGED" && after.state === "MERGED") {
      for (const issue of after.closingIssues) {
        out.push({ kind: "pr-merged-closes", pr: num, issue, ts });
      }
    }
  }

  return out;
}
