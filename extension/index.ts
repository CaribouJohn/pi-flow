/**
 * pi-flow extension — entry point.
 *
 * Progress (Track A):
 *  - A1: skeleton + tracer `/flow-status`
 *  - A3: profile reader + `flow_profile_read`
 *  - A4: gh.ts wrapper + `flow_issues_query`
 *  - A5/A6: state machine data + validator (pure)
 *  - A7: `flow_set_state` — atomic label swap + mutation token
 *
 * Naming convention: `/flow-<verb>` for non-LLM commands; bare `/flow` is the skill.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  readProfile,
  profilePathFor,
  ProfileError,
  labelForStateKey,
  stateKeyForLabel,
  type Profile,
} from "./profile.ts";
import { createGh, type GhIssueRef, GhError } from "./gh.ts";
import { parseDependsOn, parseTrackParent } from "./flow-deps.ts";
import { discover as discoverResources, skillsRoot } from "./resources.ts";
import {
  STATE_KEYS,
  stateForKey,
  keyForState,
  type State,
  type StateKey,
} from "./state-machine.ts";
import { validateTransition } from "./state-validator.ts";
import {
  createMutationRegistry,
  type MutationRegistry,
} from "./mutation-registry.ts";
import { createPreflightFromPi } from "./preflight.ts";

function formatIssueLines(issues: GhIssueRef[]): string[] {
  return issues.map(
    (i) =>
      `#${String(i.number).padStart(3)}  ${i.title}  [${i.labels.join(",")}]`,
  );
}

function profileErrorHint(err: unknown): string {
  if (err instanceof ProfileError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the (unique) flow-state label currently on an issue.
 * Returns `{key, label, state}` if exactly one; null if none; throws if
 * more than one (which means a label was added without a paired removal —
 * a data-integrity bug worth surfacing rather than papering over).
 */
function currentStateOnIssue(
  profile: Profile,
  issue: GhIssueRef,
): { key: StateKey; label: string; state: State } | null {
  const stateLabelValues = new Set(Object.values(profile.labels.state));
  const present = issue.labels.filter((l) => stateLabelValues.has(l));
  if (present.length === 0) return null;
  if (present.length > 1) {
    throw new Error(
      `Issue #${issue.number} has ${present.length} flow-state labels at once: ${present.join(", ")}. Repair by removing all but one before retrying.`,
    );
  }
  const label = present[0]!;
  const key = stateKeyForLabel(profile, label);
  if (!key) {
    // Can't happen given the filter above, but the type system doesn't know.
    throw new Error(`Internal: label ${label} on #${issue.number} unmapped`);
  }
  const state = stateForKey(key);
  if (!state) {
    throw new Error(`Internal: state-key ${key} on #${issue.number} unmapped`);
  }
  return { key: key as StateKey, label, state };
}

export default function (pi: ExtensionAPI): void {
  const gh = createGh(pi);
  const mutationRegistry: MutationRegistry = createMutationRegistry();
  const preflight = createPreflightFromPi(pi);
  // mutationRegistry is closure-shared with future slices added to this
  // default-export (AFK loop, status widget). Do not export across module
  // boundaries unless that need actually arrives.

  // ---------- Tool: setup_flow_preflight ----------
  pi.registerTool({
    name: "setup_flow_preflight",
    label: "Setup flow preflight",
    description:
      "Deterministic check before `/flow setup` (or any other mutational setup step) runs: verifies `gh` is authenticated for github.com, and parses `owner/repo` from the `origin` git remote. Returns a structured result with `ok`, `ghAuthed`, `ghUser`, `owner`, `repo`, and a per-failure `errors` array (codes: `gh_not_authed`, `no_origin`, `unparseable_remote`). Read-only — never mutates.",
    promptSnippet:
      "Run preflight (gh auth + origin detection) before the setup wizard does anything.",
    promptGuidelines: [
      "Always call setup_flow_preflight as the first step of /flow setup. If ok=false, surface every error message verbatim and stop — do not attempt subsequent setup tools.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const result = await preflight.run({ signal });
      const lines: string[] = [];
      lines.push(`preflight: ${result.ok ? "OK" : "FAIL"}`);
      lines.push(
        `  gh: ${result.ghAuthed ? `authed${result.ghUser ? ` as ${result.ghUser}` : ""}` : "not authed"}`,
      );
      if (result.owner && result.repo) {
        lines.push(`  repo: ${result.owner}/${result.repo}`);
      } else {
        lines.push(`  repo: (not detected)`);
      }
      if (result.errors.length > 0) {
        lines.push(`  errors:`);
        for (const e of result.errors) {
          lines.push(`    [${e.code}] ${e.message}`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ---------- Tool: flow_profile_read ----------
  pi.registerTool({
    name: "flow_profile_read",
    label: "Read flow profile",
    description:
      "Read and parse the repo's `.pi/flow.profile.md` (YAML frontmatter + prose body). Returns the typed config the rest of the flow tools key off — label names, verify gate command, reviewer command, AFK cadence, AI disclaimer, etc.",
    promptSnippet:
      "Read the parsed flow profile (label names, verify gate, reviewer cmd, AFK cadence, etc.).",
    promptGuidelines: [
      "Call flow_profile_read before any other flow_ tool so label and command names are profile-resolved, not assumed.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);
      const summary = [
        `tracker: ${profile.tracker}`,
        `repo: ${profile.repo}`,
        `default_branch: ${profile.default_branch}`,
        `track_branch_prefix: ${profile.track_branch_prefix}`,
        `verify_gate: ${profile.verify_gate}`,
        `reviewer_command: ${profile.reviewer_command} (cap=${profile.reviewer_iteration_cap})`,
        `poll_cadence_seconds: ${profile.poll_cadence_seconds}`,
        `state labels: ${Object.keys(profile.labels.state).length} (e.g. ready_for_agent=${profile.labels.state.ready_for_agent})`,
      ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: profile,
      };
    },
  });

  // ---------- Tool: flow_issues_query ----------
  pi.registerTool({
    name: "flow_issues_query",
    label: "Query flow issues",
    description:
      "List open GitHub issues currently labelled with a given flow state. The `state` parameter is a state-axis key (e.g. `needs_acceptance`); it is resolved to the actual label name via the profile, so renamed labels still work. Use `extra` for raw additional `gh issue list` flags (e.g. `[\"--assignee\", \"@me\"]`).",
    promptSnippet:
      "List issues currently in a given flow state (`needs_acceptance`, `ready_for_agent`, ...).",
    promptGuidelines: [
      "Use flow_issues_query for any flow-state query; do not shell out to gh directly.",
    ],
    parameters: Type.Object({
      state: StringEnum(STATE_KEYS),
      extra: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);
      const label = labelForStateKey(profile, params.state);
      if (!label) {
        throw new Error(
          `Unknown state key '${params.state}'. Valid keys: ${STATE_KEYS.join(", ")}`,
        );
      }
      const issues = await gh.listIssues({
        labels: [label],
        state: "open",
        extra: params.extra,
        signal,
      });
      const summary =
        issues.length === 0
          ? `No open issues labelled ${label}.`
          : [
              `${issues.length} open issue(s) labelled ${label}:`,
              ...formatIssueLines(issues),
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: { stateKey: params.state, label, count: issues.length, issues },
      };
    },
  });

  // ---------- Tool: flow_set_state ----------
  pi.registerTool({
    name: "flow_set_state",
    label: "Set flow state",
    description:
      "Atomically move an issue to a new flow state. Reads the issue's current state label, validates the transition against the v1 state machine (refusing illegal moves with the legal targets listed in the error), performs the label swap in a single gh API call, and records a mutation token so the AFK poller treats the change as ours. Returns a brief result; no comment is posted (use flow_comment for that).",
    promptSnippet:
      "Move an issue to a new flow state (validates the transition, atomic label swap, records a mutation token).",
    promptGuidelines: [
      "Call flow_set_state for every state move; never edit labels directly.",
      "If the call fails with 'Illegal transition', read the listed legal targets and either pick a legal arrow or escalate to needs_info / ready_for_human.",
    ],
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1 }),
      to: StringEnum(STATE_KEYS),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);

      const targetLabel = labelForStateKey(profile, params.to);
      if (!targetLabel) {
        throw new Error(
          `Unknown target state '${params.to}'. Valid keys: ${STATE_KEYS.join(", ")}`,
        );
      }
      const targetState = stateForKey(params.to);
      if (!targetState) {
        throw new Error(`Unknown target state '${params.to}'`);
      }

      const issue = await gh.viewIssue(params.issue, { signal });
      const current = currentStateOnIssue(profile, issue);
      const fromState: State | null = current?.state ?? null;

      // Validator wants concrete from-state. If the issue has none, we
      // permit any agent-pickable initial move (mirrors the "newly filed"
      // case where labelling is the first state assignment).
      let result: ReturnType<typeof validateTransition>;
      if (fromState == null) {
        result = { ok: true, kind: "transition" };
      } else {
        result = validateTransition(fromState, targetState);
      }

      if (!result.ok) {
        throw new Error(result.reason);
      }

      if (result.kind === "noop") {
        return {
          content: [
            {
              type: "text",
              text: `noop: #${params.issue} already in '${targetState}'.`,
            },
          ],
          details: {
            issue: params.issue,
            from: fromState,
            to: targetState,
            kind: "noop" as const,
          },
        };
      }

      await gh.editIssueLabels(params.issue, {
        add: [targetLabel],
        remove: current ? [current.label] : [],
        signal,
      });
      const token = mutationRegistry.record(params.issue, targetState);

      const reasonTail = params.reason ? ` (${params.reason})` : "";
      return {
        content: [
          {
            type: "text",
            text: `#${params.issue}: ${fromState ?? "(no state)"} → ${targetState}${reasonTail}.`,
          },
        ],
        details: {
          issue: params.issue,
          from: fromState,
          fromKey: current ? current.key : null,
          to: targetState,
          toKey: keyForState(targetState),
          toLabel: targetLabel,
          fromLabel: current?.label ?? null,
          tokenExpiresAt: token.expiresAt,
        },
      };
    },
  });

  // ---------- Tool: flow_next_assignable ----------
  /**
   * Returns ready-for-agent issues whose every dep (parsed from
   * `Depends on: #N` lines in the body) is closed. Optionally scoped to a
   * track parent (only issues with `Tracked: #<parent>`).
   *
   * Serial gh issue view per unique dep — fine at v1 scale (<20 candidates,
   * <5 deps each). If this becomes a bottleneck, batch via
   * `gh api graphql` in a follow-up slice.
   */
  async function computeAssignable(
    opts: { trackParent?: number; signal?: AbortSignal },
    profile: Profile,
  ): Promise<{ assignable: GhIssueRef[]; blocked: Array<{ issue: GhIssueRef; openDeps: number[] }> }> {
    const readyLabel = profile.labels.state.ready_for_agent;
    let candidates = await gh.listIssues({
      labels: [readyLabel],
      state: "open",
      limit: 100,
      signal: opts.signal,
    });
    if (opts.trackParent != null) {
      const parent = opts.trackParent;
      candidates = candidates.filter((c) => parseTrackParent(c.body) === parent);
    }

    // Cache dep lookups across candidates (sibling slices share deps).
    const depState = new Map<number, "OPEN" | "CLOSED">();
    async function isDepClosed(n: number): Promise<boolean> {
      const cached = depState.get(n);
      if (cached) return cached === "CLOSED";
      const dep = await gh.viewIssue(n, { signal: opts.signal });
      depState.set(n, dep.state);
      return dep.state === "CLOSED";
    }

    const assignable: GhIssueRef[] = [];
    const blocked: Array<{ issue: GhIssueRef; openDeps: number[] }> = [];
    for (const issue of candidates) {
      const deps = parseDependsOn(issue.body);
      const open: number[] = [];
      for (const d of deps) {
        if (!(await isDepClosed(d))) open.push(d);
      }
      if (open.length === 0) assignable.push(issue);
      else blocked.push({ issue, openDeps: open });
    }
    return { assignable, blocked };
  }

  pi.registerTool({
    name: "flow_next_assignable",
    label: "Next assignable slice(s)",
    description:
      "List ready-for-agent issues whose every `Depends on: #N` is closed. Optionally scope to a `trackParent` (only issues marked `Tracked: #<parent>` count). Returns assignable issues + blocked-with-reasons so the LLM can either pick one or report why nothing is pickable.",
    promptSnippet:
      "Find the next slice an agent can pick up (deps satisfied), optionally within a single track.",
    parameters: Type.Object({
      trackParent: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);
      const { assignable, blocked } = await computeAssignable(
        { trackParent: params.trackParent, signal },
        profile,
      );
      const lines: string[] = [];
      if (assignable.length === 0) {
        lines.push(`No assignable issues${params.trackParent ? ` under track #${params.trackParent}` : ""}.`);
      } else {
        lines.push(`${assignable.length} assignable issue(s):`);
        lines.push(...formatIssueLines(assignable));
      }
      if (blocked.length > 0) {
        lines.push(``, `Blocked (${blocked.length}):`);
        for (const { issue, openDeps } of blocked) {
          lines.push(
            `  #${issue.number} — waiting on ${openDeps.map((d) => `#${d}`).join(", ")}`,
          );
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          assignableCount: assignable.length,
          blockedCount: blocked.length,
          assignable,
          blocked,
        },
      };
    },
  });

  // ---------- Command: /flow-next ----------
  pi.registerCommand("flow-next", {
    description: "Print the next assignable slice (ready-for-agent with all deps closed)",
    handler: async (_args, ctx) => {
      let profile: Profile;
      try {
        profile = readProfile(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(
          `Could not read flow profile: ${profileErrorHint(err)}`,
          "error",
        );
        return;
      }
      let result;
      try {
        result = await computeAssignable({ signal: ctx.signal }, profile);
      } catch (err) {
        const msg =
          err instanceof GhError
            ? `${err.message}\nHint: check 'gh auth status'.`
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.ui.notify(msg, "error");
        return;
      }
      const lines: string[] = [];
      if (result.assignable.length === 0) {
        lines.push("No assignable issues right now.");
      } else {
        lines.push(`${result.assignable.length} assignable:`);
        lines.push(...formatIssueLines(result.assignable));
      }
      if (result.blocked.length > 0) {
        lines.push(``, `Blocked (${result.blocked.length}):`);
        for (const { issue, openDeps } of result.blocked) {
          lines.push(
            `  #${issue.number} — ${issue.title}  (waits on ${openDeps.map((d) => `#${d}`).join(", ")})`,
          );
        }
      }
      pi.sendMessage({
        customType: "flow-next",
        content: lines.join("\n"),
        display: true,
      });
    },
  });

  // ---------- Tool: flow_comment ----------
  /**
   * Compose the final comment body: prepend the profile's AI disclaimer
   * once (if not already present in the input), then a blank line, then
   * the body. Idempotent: if the LLM already prepended the disclaimer,
   * we don't double it up.
   */
  function composeComment(profile: Profile, body: string): string {
    const disclaimer = profile.ai_disclaimer;
    const trimmed = body.trimStart();
    if (trimmed.startsWith(disclaimer)) return body;
    return `${disclaimer}\n\n${body}`;
  }

  pi.registerTool({
    name: "flow_comment",
    label: "Comment on issue",
    description:
      "Post a comment on a GitHub issue. The profile's AI disclaimer is automatically prepended (or detected and left alone if the body already opens with it) so every agent-authored comment is identifiable. Use for state-change rationales, plan-gate verdicts, info requests, and acceptance verdicts.",
    promptSnippet:
      "Post a comment on an issue (AI disclaimer prepended automatically).",
    promptGuidelines: [
      "Never call `gh issue comment` directly — always use flow_comment so the disclaimer is enforced.",
      "Keep comments short and actionable. State changes belong in flow_set_state's reason field, not comments.",
    ],
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);
      const composed = composeComment(profile, params.body);
      await gh.commentOnIssue(params.issue, composed, { signal });
      return {
        content: [
          { type: "text", text: `Commented on #${params.issue} (${composed.length} chars).` },
        ],
        details: {
          issue: params.issue,
          length: composed.length,
          disclaimerApplied: !params.body.trimStart().startsWith(profile.ai_disclaimer),
        },
      };
    },
  });

  // ---------- Tool: flow_verify ----------
  pi.registerTool({
    name: "flow_verify",
    label: "Run verify gate",
    description:
      "Run the profile's `verify_gate` shell command (via `bash -c`). Returns the exit code and the tail of stdout/stderr. Exit 0 = green; any other code is a failure the agent must surface (and must NOT merge over).",
    promptSnippet:
      "Run the verify gate before merging a slice into its track branch.",
    promptGuidelines: [
      "Always call flow_verify before closing a slice or merging into a track branch.",
      "On non-zero exit, report the tail to the human and stop — do not retry by changing the verify_gate.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const profile = readProfile(ctx.cwd);
      const cmd = profile.verify_gate;
      const started = Date.now();
      let r: Awaited<ReturnType<typeof pi.exec>>;
      try {
        r = await pi.exec("bash", ["-c", cmd], { signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `verify gate failed to spawn (bash not on PATH?): ${msg}`,
        );
      }
      const elapsedMs = Date.now() - started;
      const tailOf = (s: string, lines = 40) => {
        const arr = (s ?? "").split(/\r?\n/);
        return arr.slice(-lines).join("\n");
      };
      const ok = r.code === 0;
      const summary = [
        `verify gate: ${ok ? "PASS" : `FAIL (exit ${r.code})`} in ${elapsedMs}ms`,
        `command: ${cmd}`,
        r.stdout ? `--- stdout (tail) ---\n${tailOf(r.stdout)}` : "(no stdout)",
        r.stderr ? `--- stderr (tail) ---\n${tailOf(r.stderr)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!ok) {
        throw new Error(summary);
      }
      return {
        content: [{ type: "text", text: summary }],
        details: { ok, exitCode: r.code, elapsedMs, command: cmd },
      };
    },
  });

  // ---------- Tool: resources_discover ----------
  pi.registerTool({
    name: "resources_discover",
    label: "Discover skill resources",
    description:
      "List every file under `extension/skills/`, optionally scoped to a single skill directory (`flow`, `setup-flow`). Use this when you need to know what guidance / templates / snippets ship with the extension before reading any specific file. Paths are relative to cwd, forward-slashed.",
    promptSnippet:
      "List the prompts / templates / snippets shipped under extension/skills/.",
    parameters: Type.Object({
      skill: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const files = discoverResources(ctx.cwd, { skill: params.skill });
      const summary =
        files.length === 0
          ? `No resources under ${skillsRoot(ctx.cwd)}${params.skill ? `/${params.skill}` : ""}.`
          : [
              `${files.length} resource(s)${params.skill ? ` under ${params.skill}` : ""}:`,
              ...files.map((f) => `  ${f}`),
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: { count: files.length, files },
      };
    },
  });

  // ---------- Command: /flow-status ----------
  pi.registerCommand("flow-status", {
    description: "List issues currently labelled `ready_for_agent` (profile-resolved)",
    handler: async (_args, ctx) => {
      let readyLabel: string;
      try {
        const profile = readProfile(ctx.cwd);
        readyLabel = profile.labels.state.ready_for_agent;
      } catch (err) {
        ctx.ui.notify(
          `Could not read flow profile: ${profileErrorHint(err)}\nHint: ensure ${profilePathFor(ctx.cwd)} exists with valid YAML frontmatter.`,
          "error",
        );
        return;
      }

      let issues: GhIssueRef[];
      try {
        issues = await gh.listIssues({
          labels: [readyLabel],
          state: "open",
          limit: 50,
          signal: ctx.signal,
        });
      } catch (err) {
        const msg =
          err instanceof GhError
            ? `${err.message}\nHint: check 'gh auth status'.`
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.ui.notify(msg, "error");
        return;
      }

      const content =
        issues.length === 0
          ? `No ${readyLabel} issues.`
          : [`${issues.length} ${readyLabel} issue(s):`, ...formatIssueLines(issues)].join("\n");

      pi.sendMessage({
        customType: "flow-status",
        content,
        display: true,
      });
    },
  });
}
