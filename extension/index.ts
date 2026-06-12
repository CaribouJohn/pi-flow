/**
 * pi-flow extension — entry point.
 *
 * Progress (Track A):
 * - A1: skeleton + tracer `/flow-status` (hardcoded label)
 * - A3: profile reader + `flow_profile_read` tool; `/flow-status` profile-driven
 * - A4: `gh.ts` wrapper + `flow_issues_query` tool; `/flow-status` now uses
 *   `gh.listIssues` (no more inline `pi.exec` for `gh`).
 *
 * Naming convention: `/flow-<verb>` for non-LLM commands; bare `/flow` is the skill.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readProfile, profilePathFor, ProfileError } from "./profile.ts";
import { createGh, type GhIssueRef, GhError } from "./gh.ts";

/** State-axis keys understood by `flow_issues_query`. Matches `Profile.labels.state`. */
const STATE_KEYS = [
  "needs_triage",
  "needs_info",
  "needs_grilling",
  "needs_slicing",
  "needs_plan_review",
  "tracking",
  "ready_for_agent",
  "ready_for_human",
  "needs_acceptance",
  "wontfix",
] as const;

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

export default function (pi: ExtensionAPI): void {
  const gh = createGh(pi);

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
      const stateKey = params.state as (typeof STATE_KEYS)[number];
      const label = profile.labels.state[stateKey];
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
        details: { stateKey, label, count: issues.length, issues },
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
