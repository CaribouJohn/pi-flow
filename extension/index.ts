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
  // mutationRegistry is closure-shared with future slices added to this
  // default-export (AFK loop, status widget). Do not export across module
  // boundaries unless that need actually arrives.

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
