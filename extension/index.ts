/**
 * pi-flow extension — entry point.
 *
 * A1 tracer-bullet: registers a single non-LLM command `/flow-status` that
 * lists issues currently labelled `ready-for-agent` on the current repo via
 * `gh`. No profile reading yet (A3 makes labels profile-driven); no other
 * tools (A3–A10 add them).
 *
 * Design note on naming: pi slash commands are flat (no spaces). The DESIGN.md
 * shorthand "/flow status" maps here to `/flow-status`. Using `/flow` as an
 * extension command would shadow the `/flow` skill, so the convention adopted
 * here is `/flow-<verb>` for non-LLM commands, leaving the bare `/flow` for
 * the skill's natural-language entry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READY_LABEL = "ready-for-agent"; // hardcoded for A1; A3 makes this profile-driven

type GhIssue = {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
};

function formatSummary(issues: GhIssue[]): string {
  if (issues.length === 0) {
    return `No ${READY_LABEL} issues.`;
  }
  const lines = issues.map((i) => {
    const labels = i.labels.map((l) => l.name).join(",");
    return `#${String(i.number).padStart(3)}  ${i.title}  [${labels}]`;
  });
  return [`${issues.length} ${READY_LABEL} issue(s):`, ...lines].join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("flow-status", {
    description: `List issues currently labelled ${READY_LABEL}`,
    handler: async (_args, ctx) => {
      let result: Awaited<ReturnType<typeof pi.exec>>;
      try {
        result = await pi.exec(
          "gh",
          [
            "issue",
            "list",
            "-l",
            READY_LABEL,
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
        content: formatSummary(issues),
        display: true,
      });
    },
  });
}
