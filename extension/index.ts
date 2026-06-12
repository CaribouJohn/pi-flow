/**
 * pi-flow extension — entry point.
 *
 * Current state (per Track A progress):
 * - A1: extension skeleton + tracer `/flow-status` (label hardcoded then)
 * - A3: profile reader + `flow_profile_read` tool; `/flow-status` is now
 *   profile-driven (reads `labels.state.ready_for_agent` instead of a constant).
 *
 * Naming convention (locked in at A1): `/flow-<verb>` for non-LLM commands,
 * leaving the bare `/flow` for the skill's natural-language entry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readProfile, profilePathFor, ProfileError } from "./profile.ts";

type GhIssue = {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
};

function formatStatusSummary(label: string, issues: GhIssue[]): string {
  if (issues.length === 0) {
    return `No ${label} issues.`;
  }
  const lines = issues.map((i) => {
    const labels = i.labels.map((l) => l.name).join(",");
    return `#${String(i.number).padStart(3)}  ${i.title}  [${labels}]`;
  });
  return [`${issues.length} ${label} issue(s):`, ...lines].join("\n");
}

function profileErrorHint(err: unknown): string {
  if (err instanceof ProfileError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function (pi: ExtensionAPI): void {
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

      let result: Awaited<ReturnType<typeof pi.exec>>;
      try {
        result = await pi.exec(
          "gh",
          [
            "issue",
            "list",
            "-l",
            readyLabel,
            "--json",
            "number,title,labels",
            "--limit",
            "50",
          ],
          { signal: ctx.signal },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `gh failed to start: ${msg}. Is gh installed and on PATH?`,
          "error",
        );
        return;
      }

      if (result.code !== 0) {
        const stderr = (result.stderr ?? "").trim();
        ctx.ui.notify(
          `gh exited ${result.code}. ${stderr}\nHint: check 'gh auth status'.`,
          "error",
        );
        return;
      }

      let issues: GhIssue[];
      try {
        issues = JSON.parse(result.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not parse gh JSON output: ${msg}`, "error");
        return;
      }

      pi.sendMessage({
        customType: "flow-status",
        content: formatStatusSummary(readyLabel, issues),
        display: true,
      });
    },
  });
}
