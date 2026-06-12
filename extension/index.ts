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
import { createSetupLabels, defaultLoadCanonical } from "./setup-labels.ts";
import {
  createSetupTemplates,
  defaultFs as defaultTemplatesFs,
  defaultLoadBundled,
} from "./setup-templates.ts";
import {
  createScaffoldProfile,
  defaultLoadTemplateBody,
  defaultScaffoldFs,
} from "./scaffold-profile.ts";
import { runSetupWizard, runSetupEdit, runSetupReset } from "./setup-wizard.ts";
import {
  createAfkState,
  renderStatusWidget,
  deriveCounts,
  replayAfkEntries,
  deriveStartupWidget,
  AFK_ENTRY_TYPE,
  type AfkEntry,
  type AfkState,
  type StubTicker,
} from "./afk-state.ts";
import { createPoller, type Poller } from "./poller-scheduler.ts";
import type { Diff, Snapshot } from "./poller.ts";
import { runOneTick, type AfkLoopDeps } from "./afk-loop.ts";
import {
  replayIterations,
  AFK_ITERATION_ENTRY_TYPE,
} from "./afk-iteration.ts";
import {
  buildOnDiffHandler,
  buildPollDepsFromPi,
  createBlockTransitionState,
  type PollerReactionDeps,
} from "./afk-poller-wiring.ts";
import {
  buildRealDeps,
  onTickOutcomeReset,
  type BuildRealDepsOpts,
} from "./afk-wiring.ts";
import {
  wireAutoCompact,
  resolveCompactThreshold,
} from "./afk-compaction.ts";
import {
  createIssueAutocompleteProvider,
  createIssueCache,
  collectFlowLabels,
  isFlowLabelled,
  type IssueCache,
  type IssueLite,
} from "./issue-autocomplete.ts";
import {
  implementSpawn,
  currentSpawnDepth,
  SPAWN_DEPTH_ENV,
} from "./implement-spawn.ts";
import { reviewSpawn } from "./review-spawn.ts";
import { existsSync, rmSync } from "node:fs";

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

  // ---------- Tool: setup_flow_apply_labels ----------
  pi.registerTool({
    name: "setup_flow_apply_labels",
    label: "Setup flow apply labels",
    description:
      "Idempotent label bootstrap. Reads the canonical label vocabulary from `extension/skills/setup-flow/labels.md` and `gh label create`s anything missing in the current repo. Never edits or deletes existing labels — colour/description drift is reported in `details.drift` but not auto-corrected. `dryRun: true` lists what would be created without calling `gh`.",
    promptSnippet:
      "Apply the canonical pi-flow label set to this repo, creating only what's missing.",
    promptGuidelines: [
      "Run setup_flow_apply_labels after preflight succeeds. Re-running is safe: it reports already-present labels rather than recreating them. Surface any `drift` entries to the user verbatim — do not attempt to fix them.",
    ],
    parameters: Type.Object({
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "If true, list what would be created in `skippedDueToDryRun` without calling `gh label create`.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const setupLabels = createSetupLabels({
        gh,
        loadCanonical: defaultLoadCanonical(ctx.cwd),
      });
      const result = await setupLabels.apply({
        dryRun: params.dryRun ?? false,
        signal,
      });
      const lines: string[] = [];
      lines.push(
        `labels: ${result.created.length} created, ${result.alreadyPresent.length} already present` +
          (result.skippedDueToDryRun.length > 0
            ? `, ${result.skippedDueToDryRun.length} would-create (dry run)`
            : ""),
      );
      if (result.created.length > 0) {
        lines.push(`  created: ${result.created.join(", ")}`);
      }
      if (result.skippedDueToDryRun.length > 0) {
        lines.push(`  would create: ${result.skippedDueToDryRun.join(", ")}`);
      }
      if (result.drift.length > 0) {
        lines.push(`  drift (${result.drift.length}):`);
        for (const d of result.drift) {
          const colorMismatch =
            d.actual.color !== d.canonical.color
              ? `color ${d.actual.color}→${d.canonical.color}`
              : "";
          const descMismatch =
            d.actual.description !== d.canonical.description
              ? `desc "${d.actual.description}"→"${d.canonical.description}"`
              : "";
          lines.push(
            `    ${d.name}: ${[colorMismatch, descMismatch].filter(Boolean).join("; ")}`,
          );
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ---------- Tool: setup_flow_apply_issue_templates ----------
  pi.registerTool({
    name: "setup_flow_apply_issue_templates",
    label: "Setup flow apply issue templates",
    description:
      "Copies the bundled GitHub issue-form YAMLs (triage / tracking / slice) from `extension/skills/setup-flow/issue-templates/` to `.github/ISSUE_TEMPLATE/` in the user's repo. Creates the directory if missing. Does not commit — files are left in the working tree for the user to inspect. By default, never overwrites an existing template; pass `overwrite: true` to force.",
    promptSnippet:
      "Drop the canonical pi-flow issue forms into .github/ISSUE_TEMPLATE/ (no commit).",
    promptGuidelines: [
      "Run setup_flow_apply_issue_templates after labels are applied. Files are uncommitted on purpose — tell the user to `git add .github/ISSUE_TEMPLATE` and commit when they're happy with the result. Use overwrite:true only when the user explicitly asks to restore canonical templates.",
    ],
    parameters: Type.Object({
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "If true, replace any existing .github/ISSUE_TEMPLATE/<name>.yml. Default false.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const setupTemplates = createSetupTemplates({
        loadBundled: defaultLoadBundled(ctx.cwd),
        cwd: ctx.cwd,
        fs: defaultTemplatesFs(),
      });
      const result = await setupTemplates.apply({
        overwrite: params.overwrite ?? false,
      });
      const lines: string[] = [];
      lines.push(
        `issue templates: ${result.written.length} written, ${result.skippedExisting.length} skipped (already present)`,
      );
      if (result.written.length > 0) {
        lines.push(`  written: ${result.written.join(", ")}`);
      }
      if (result.skippedExisting.length > 0) {
        lines.push(`  skipped: ${result.skippedExisting.join(", ")}`);
        lines.push(`  hint: re-run with overwrite:true to replace existing.`);
      }
      if (result.written.length > 0) {
        lines.push(
          `  note: files left uncommitted under .github/ISSUE_TEMPLATE/ — commit when ready.`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ---------- Tool: setup_flow_scaffold_profile ----------
  pi.registerTool({
    name: "setup_flow_scaffold_profile",
    label: "Setup flow scaffold profile",
    description:
      "Writes `.pi/flow.profile.md` from an answers object (collected by the /flow setup wizard) and the canonical body template. Frontmatter is synthesised so the file round-trips through `flow_profile_read`. Refuses to overwrite an existing profile unless `overwrite:true` is passed (then `/flow setup --edit` and `--reset` use it). No commit — the file is left in the working tree.",
    promptSnippet:
      "Write .pi/flow.profile.md from the collected wizard answers (no commit).",
    promptGuidelines: [
      "Call setup_flow_scaffold_profile only after collecting the wizard answers. If it returns {written:false, reason:'exists'} during a fresh-repo run, surface that to the user and stop — the edit / reset paths belong to /flow setup --edit and --reset, not to this tool.",
    ],
    parameters: Type.Object({
      answers: Type.Object({
        owner: Type.String({ description: "GitHub owner (user or org)." }),
        repo: Type.String({ description: "GitHub repo name." }),
        defaultBranch: Type.String({
          description: "Default branch (e.g. 'main').",
        }),
        trackBranchPrefix: Type.Optional(Type.String()),
        verifyGate: Type.Optional(Type.String()),
        inSituHarness: Type.Optional(Type.String()),
        reviewerCommand: Type.Optional(Type.String()),
        reviewerIterationCap: Type.Optional(Type.Number()),
        pollCadenceSeconds: Type.Optional(Type.Number()),
        aiDisclaimer: Type.Optional(Type.String()),
        labelOverrides: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Map of state-key (e.g. 'ready_for_agent') to non-default label string.",
          }),
        ),
      }),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "If true, replace an existing .pi/flow.profile.md. Default false.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scaffold = createScaffoldProfile({
        cwd: ctx.cwd,
        fs: defaultScaffoldFs(),
        loadTemplateBody: defaultLoadTemplateBody(ctx.cwd),
        loadCanonicalLabelsMd: defaultLoadCanonical(ctx.cwd),
      });
      const result = await scaffold.run(params.answers, {
        overwrite: params.overwrite ?? false,
      });
      const text = result.written
        ? `profile written: ${result.path} (uncommitted)`
        : `profile already exists at ${result.path} — not overwritten (reason: ${result.reason}). Re-run with overwrite:true to replace.`;
      return {
        content: [{ type: "text", text }],
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
      // Additive issue-label log for the B-track poller. Record both
      // directions so the poller suppresses on either label-added or
      // label-removed diffs.
      mutationRegistry.recordIssueMutation(params.issue, targetLabel);
      if (current) {
        mutationRegistry.recordIssueMutation(params.issue, current.label);
      }
      // B4: refresh the AFK widget after any successful mutation.
      // No-op if AFK isn't active. Best-effort — a render failure here
      // must not surface as a tool failure.
      try {
        refreshAfkWidget();
      } catch {
        /* swallow */
      }

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

  // ---------- Tool: flow_review_spawn (B7) ----------
  pi.registerTool({
    name: "flow_review_spawn",
    label: "Spawn reviewer sub-agent",
    description:
      "Orchestrator-only: spawn a fresh-context `pi` subprocess to review a slice branch (optionally a PR) and return a structured `{verdict, comments[]}` verdict via a JSON result-file contract. The reviewer fetches its own diff via `gh pr diff` / `git diff` (bash is available to the sub-session). Refuses to run if PI_FLOW_SPAWN_DEPTH > 0 (recursion guard). Caller is responsible for posting comments back to the PR / advancing state on the verdict.",
    promptSnippet:
      "Spawn a reviewer sub-agent for a single slice branch; await the structured verdict.",
    promptGuidelines: [
      "Only the orchestrator (the top-level AFK loop) should call this. If you are inside a spawned sub-session, do NOT call it — the recursion guard will reject you.",
      "Pass prNumber when the slice already has a PR (lets the reviewer use `gh pr diff $N`); omit it for pre-PR reviews.",
      "Do NOT call flow_set_state or flow_comment based on the verdict here; B8's loop body owns those moves.",
      "sliceBrief should restate the slice's acceptance criteria so the reviewer can judge against intent, not just diff aesthetics.",
    ],
    parameters: Type.Object({
      issueNumber: Type.Integer({ minimum: 1 }),
      sliceBranch: Type.String({ minLength: 1 }),
      baseBranch: Type.String({ minLength: 1 }),
      prNumber: Type.Optional(Type.Integer({ minimum: 1 })),
      sliceBrief: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // Recursion guard — shared with flow_implement_spawn.
      const depth = currentSpawnDepth(process.env);
      if (depth > 0) {
        throw new Error(
          `flow_review_spawn refused: already inside a pi-flow sub-session (${SPAWN_DEPTH_ENV}=${depth}). Sub-agents may not spawn further sub-agents.`,
        );
      }

      const profile = readProfile(ctx.cwd);

      const result = await reviewSpawn({
        issueNumber: params.issueNumber,
        sliceBranch: params.sliceBranch,
        baseBranch: params.baseBranch,
        prNumber: params.prNumber,
        sliceBrief: params.sliceBrief,
        cwd: ctx.cwd,
        model: params.model,
        currentDepth: depth,
        reviewerCommand: profile.reviewer_command,
        signal,
      });

      const lines: string[] = [
        `flow_review_spawn(#${params.issueNumber} on ${params.sliceBranch}): outcome=${result.outcome}`,
      ];
      if (result.outcome === "ok" && result.result) {
        lines.push(
          `  verdict  = ${result.result.verdict}`,
          `  comments = ${result.result.comments.length} item(s)`,
        );
        for (const c of result.result.comments.slice(0, 5)) {
          lines.push(`    - ${c.split("\n")[0].slice(0, 160)}`);
        }
        if (result.result.comments.length > 5) {
          lines.push(`    … (+${result.result.comments.length - 5} more)`);
        }
      } else {
        lines.push(`  exitCode = ${result.exitCode}`, `  reason   = ${result.reason ?? "(no reason)"}`);
        if (result.stderrTail) lines.push(`  stderr   = ${result.stderrTail}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ---------- Tool: flow_implement_spawn (B6) ----------
  pi.registerTool({
    name: "flow_implement_spawn",
    label: "Spawn implementer sub-agent",
    description:
      "Orchestrator-only: spawn a fresh-context `pi` subprocess to implement a single slice on a given branch, then collect a structured `{branch, commitSha, verifyResult}` result via a JSON result-file contract. Refuses to run if PI_FLOW_SPAWN_DEPTH > 0 (recursion guard). Caller is responsible for creating the branch before calling and for merging / opening a PR after.",
    promptSnippet:
      "Spawn an implementer sub-agent for a single slice on a single branch; await the structured result.",
    promptGuidelines: [
      "Only the orchestrator (the top-level AFK loop) should call this. If you are inside a spawned sub-session, do NOT call it — the recursion guard will reject you.",
      "Create the slice branch BEFORE calling. The child commits to it but does not create it.",
      "Do NOT call flow_set_state to advance the slice on the result of this tool; B8's loop body will read the outcome and choose the next move (review, retry, escalate, merge).",
      "taskBrief should be a self-contained handover: the slice title, body, acceptance criteria, and any cross-slice context the implementer needs.",
    ],
    parameters: Type.Object({
      issueNumber: Type.Integer({ minimum: 1 }),
      branch: Type.String({ minLength: 1 }),
      taskBrief: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // Recursion guard — refuse if we're already inside a spawned child.
      const depth = currentSpawnDepth(process.env);
      if (depth > 0) {
        throw new Error(
          `flow_implement_spawn refused: already inside a pi-flow sub-session (${SPAWN_DEPTH_ENV}=${depth}). Sub-agents may not spawn further sub-agents.`,
        );
      }

      const profile = readProfile(ctx.cwd);

      const result = await implementSpawn({
        issueNumber: params.issueNumber,
        branch: params.branch,
        taskBrief: params.taskBrief,
        verifyGate: profile.verify_gate,
        cwd: ctx.cwd,
        model: params.model,
        currentDepth: depth,
        signal,
      });

      // Compose a terse summary for the orchestrator's transcript.
      const lines: string[] = [
        `flow_implement_spawn(#${params.issueNumber} on ${params.branch}): outcome=${result.outcome}`,
      ];
      if (result.outcome === "ok" && result.result) {
        lines.push(
          `  branch    = ${result.result.branch}`,
          `  commitSha = ${result.result.commitSha || "(no commit)"}`,
          `  verify    = ${result.result.verifyResult.ok ? "PASS" : `FAIL (exit ${result.result.verifyResult.exitCode})`}`,
        );
      } else {
        lines.push(`  exitCode = ${result.exitCode}`, `  reason   = ${result.reason ?? "(no reason)"}`);
        if (result.stderrTail) lines.push(`  stderr   = ${result.stderrTail}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
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

  // ---------- Command: /flow-setup ----------
  pi.registerCommand("flow-setup", {
    description:
      "Interactive bootstrap (fresh repo) or edit / reset an existing profile. Args: '--edit' opens the settings list; '--reset' deletes the profile and re-runs the fresh wizard; bare invocation runs fresh on a clean repo and falls back to edit mode if a profile already exists.",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const mode: "reset" | "edit" | "fresh" =
        /^--?reset\b/.test(trimmed) ? "reset" :
        /^--?edit\b/.test(trimmed) ? "edit" :
        "fresh";

      const profilePath = profilePathFor(ctx.cwd);
      const preflight = createPreflightFromPi(pi);
      const setupLabels = createSetupLabels({
        gh,
        loadCanonical: defaultLoadCanonical(ctx.cwd),
      });
      const setupTemplates = createSetupTemplates({
        loadBundled: defaultLoadBundled(ctx.cwd),
        cwd: ctx.cwd,
        fs: defaultTemplatesFs(),
      });
      const scaffold = createScaffoldProfile({
        cwd: ctx.cwd,
        fs: defaultScaffoldFs(),
        loadTemplateBody: defaultLoadTemplateBody(ctx.cwd),
        loadCanonicalLabelsMd: defaultLoadCanonical(ctx.cwd),
      });

      try {
        if (mode === "reset") {
          await runSetupReset({
            cwd: ctx.cwd,
            ui: ctx.ui,
            preflight,
            labels: setupLabels,
            templates: setupTemplates,
            scaffold,
            gh,
            profileExists: () => existsSync(profilePath),
            deleteProfile: () => {
              try {
                rmSync(profilePath, { force: true });
                return !existsSync(profilePath);
              } catch {
                return false;
              }
            },
            signal: ctx.signal,
          });
          return;
        }

        // Edit mode is requested explicitly, or implicitly when bare
        // /flow-setup runs against a repo that already has a profile.
        if (mode === "edit" || (mode === "fresh" && existsSync(profilePath))) {
          if (mode === "fresh") {
            ctx.ui.notify(
              `Profile already present at ${profilePath} — entering edit mode. Use /flow-setup --reset to start over.`,
              "info",
            );
          }
          await runSetupEdit({
            ui: ctx.ui,
            scaffold,
            loadProfile: () => {
              try {
                return readProfile(ctx.cwd);
              } catch (err) {
                ctx.ui.notify(
                  `Could not read profile: ${profileErrorHint(err)}`,
                  "error",
                );
                return null;
              }
            },
          });
          return;
        }

        await runSetupWizard({
          cwd: ctx.cwd,
          ui: ctx.ui,
          preflight,
          labels: setupLabels,
          templates: setupTemplates,
          scaffold,
          gh,
          profileExists: () => existsSync(profilePath),
          signal: ctx.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/flow-setup failed: ${msg}`, "error");
      }
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

  // ---------- B4/B8c: AFK state, real loop, status widget ----------
  // B8b: per-issue reviewer-iteration count map. Replayed from
  // session entries at session_start; mutated by bumpIteration /
  // resetIteration via the B8b helpers.
  const iterMap = new Map<number, number>();

  // B8c: real AfkLoopDeps — built lazily at /flow-afk activation so the
  // profile exists. null until the first /flow-afk invocation.
  let realDeps: AfkLoopDeps | null = null;

  // B8c: real ticker — calls runOneTick(realDeps) on each tick.
  // Uses setInterval directly so cadence can be set from the profile
  // at activation time. Implements the StubTicker interface so
  // createAfkState accepts it without changes.
  let _tickerHandle: ReturnType<typeof setInterval> | null = null;
  let _tickerCadenceMs = 1000;
  const realTicker: StubTicker = {
    start() {
      if (_tickerHandle !== null) return;
      _tickerHandle = setInterval(() => {
        if (!realDeps) return;
        void runOneTick(realDeps).then(async (outcome) => {
          // On merge or escalation, reset the iteration count so
          // re-opened issues start fresh.
          if (
            (outcome.outcome === "merged" || outcome.outcome === "escalated") &&
            outcome.issueNumber !== undefined
          ) {
            await onTickOutcomeReset(pi, iterMap, outcome.issueNumber);
          }
        });
      }, _tickerCadenceMs);
    },
    stop() {
      if (_tickerHandle === null) return;
      clearInterval(_tickerHandle);
      _tickerHandle = null;
    },
    isRunning() {
      return _tickerHandle !== null;
    },
  };
  const afkState: AfkState = createAfkState(realTicker);

  // Latest poll snapshot — wired by B9 poller below.
  let latestSnapshot: Snapshot | null = null;
  // B9: block-transition state machine (one-shot fully-blocked notification).
  const blockState = createBlockTransitionState();
  // B9: poller instance — created at session_start; module-scoped so
  // /flow-afk-stop can call poller?.stop().
  let poller: Poller | null = null;
  // B10: issue-number autocomplete cache. Module-scoped so B9 can
  // later push the poller's snapshot in via `issueCache?.setFrom(...)`.
  let issueCache: IssueCache | undefined;
  // Active ctx for the widget sink. The most recent /flow-afk invocation
  // "owns" the widget; mutations refresh against that ctx. If no ctx is
  // tracked yet, refresh is a no-op (the next command invocation will
  // re-arm). This is a stub-grade ownership model — B5/B8 will revisit.
  let widgetCtx: { ui: { setWidget(k: string, lines: string[]): void } } | null = null;

  function refreshAfkWidget() {
    if (!afkState.isActive() || !widgetCtx) return;
    let profile: Profile | null = null;
    try {
      profile = readProfile(process.cwd());
    } catch {
      // Profile not readable — render the AFK-paused-style banner.
    }
    const labels = profile
      ? {
          tracking: profile.labels.state.tracking,
          needsAcceptance: profile.labels.state.needs_acceptance,
          reviewHuman: profile.labels.review.human,
          readyForAgent: profile.labels.state.ready_for_agent,
        }
      : { tracking: "tracking", needsAcceptance: "needs-acceptance", reviewHuman: "review:human", readyForAgent: "ready-for-agent" };
    // Derive next-assignable directly from the snapshot (sync, no gh call).
    const nextAssignable = (() => {
      if (!latestSnapshot) return null;
      for (const snap of latestSnapshot.issues.values()) {
        if (snap.state === "OPEN" && snap.labels.includes(labels.readyForAgent)) {
          const effortLabel = snap.labels.find((l) => l.startsWith("effort:")) ?? null;
          const effort = effortLabel ? effortLabel.replace(/^effort:/, "") : null;
          return { issue: snap.number, effort };
        }
      }
      return null;
    })();
    const counts = deriveCounts({
      snapshot: latestSnapshot,
      labels,
      nextAssignable,
      idleMinutes: null,
    });
    const lines = renderStatusWidget({
      afkActive: true,
      counts,
    });
    widgetCtx.ui.setWidget("flow", lines);
  }

  pi.registerCommand("flow-afk", {
    description: "Start AFK mode — orchestrator loop + poller heartbeat.",
    handler: async (_args, ctx) => {
      if (afkState.isActive()) {
        ctx.ui.notify("AFK already active. /flow-afk-stop to halt.", "info");
        return;
      }
      let profile;
      try {
        profile = readProfile(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(
          `Cannot start AFK: ${profileErrorHint(err)}`,
          "error",
        );
        return;
      }
      // B8c: build real deps from the current profile.
      const wiringOpts: BuildRealDepsOpts = {
        pi,
        gh,
        mutationRegistry,
        computeAssignable,
        iterMap,
        cwd: ctx.cwd,
      };
      realDeps = buildRealDeps(wiringOpts, profile);
      _tickerCadenceMs = (profile.poll_cadence_seconds ?? 30) * 1000;
      afkState.setActive(true);
      afkState.ticker.start();
      widgetCtx = ctx as unknown as typeof widgetCtx;
      refreshAfkWidget();
      const entry: AfkEntry = { afkActive: true, ts: Date.now() };
      pi.appendEntry(AFK_ENTRY_TYPE, entry);
      ctx.ui.notify(
        "AFK mode on. Real loop active (pick → implement → review → merge).",
        "info",
      );
    },
  });

  pi.registerCommand("flow-afk-stop", {
    description: "Stop AFK mode. Leaves flow state intact.",
    handler: async (_args, ctx) => {
      if (!afkState.isActive()) {
        ctx.ui.notify("AFK is already off.", "info");
        return;
      }
      afkState.setActive(false);
      afkState.ticker.stop();
      poller?.stop();
      ctx.ui.setWidget("flow", []);
      widgetCtx = null;
      const entry: AfkEntry = { afkActive: false, ts: Date.now() };
      pi.appendEntry(AFK_ENTRY_TYPE, entry);
      ctx.ui.notify("AFK mode off.", "info");
    },
  });

  // B5: on session start, replay AFK entries. Do NOT auto-resume — if
  // the last entry was "on", surface the paused banner so the human can
  // explicitly resume with /flow-afk.
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as never[];
    // B5: replay AFK toggle state.
    const latest = replayAfkEntries(entries);
    const startup = deriveStartupWidget(latest);
    if (startup.afkPaused) {
      const lines = renderStatusWidget({
        afkActive: false,
        afkPaused: true,
        counts: {
          tracksLive: 0,
          needsAcceptance: 0,
          reviewHuman: 0,
          nextAssignable: null,
          idleMinutes: null,
        },
      });
      ctx.ui.setWidget("flow", lines);
    }
    // B8b: replay iteration counts into the module-scope iterMap.
    const replayed = replayIterations(entries);
    for (const [k, v] of replayed) iterMap.set(k, v);
  });

  // B10: `#NNN` issue-number autocomplete. One `gh issue list` on
  // session start, filtered locally to flow-labelled issues. B9 will
  // later wire the poller's snapshot into `issueCache.setFrom(...)` so
  // refreshes don't cost extra `gh` calls.
  pi.on("session_start", async (_event, ctx) => {
    let profile: Profile;
    try {
      profile = readProfile(ctx.cwd);
    } catch {
      // No profile yet (pre-/flow-setup repo). Autocomplete simply
      // doesn't activate — the path-completion provider is unaffected.
      return;
    }
    const flowLabels = collectFlowLabels(profile);
    const gh = createGh(pi);

    issueCache = createIssueCache(async () => {
      try {
        const issues = await gh.listIssues({ state: "open", limit: 200 });
        const lite: IssueLite[] = issues
          .filter((i) => isFlowLabelled(i.labels, flowLabels))
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: i.labels,
          }));
        return lite;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `pi-flow: issue autocomplete failed to load: ${msg}`,
          "error",
        );
        return undefined;
      }
    });

    // Kick off the first load eagerly so the first `#` keystroke is fast.
    void issueCache.get();

    ctx.ui.addAutocompleteProvider(((current: unknown) =>
      createIssueAutocompleteProvider(
        current as never,
        () => issueCache!.get(),
      )) as never);
  });

  // ---------- B11: auto-compact on token threshold ----------
  wireAutoCompact({
    pi: pi as Parameters<typeof wireAutoCompact>[0]["pi"],
    getAfkActive: () => afkState.isActive(),
    getTrackBranch: () => realDeps?.trackBranch ?? null,
    getIterMap: () => iterMap,
    getRecentMutationIssues: () => {
      // Best-effort: look up profile for any recent mutation issue numbers.
      // MutationRegistry doesn't expose a list, so we return empty.
      return [];
    },
    getThreshold: () => {
      try {
        const profile = readProfile(process.cwd());
        return resolveCompactThreshold(profile.orchestrator_compact_threshold_tokens);
      } catch {
        return 100_000;
      }
    },
    onCompactError: (_err) => {
      // On compaction error, apply review:human on any in-flight issue
      // so it doesn't get lost. Best-effort.
      // (realDeps is available; we don't have the current issue number
      // here — a future slice could thread it through.)
    },
  });

  // ---------- B9: poller setup + diff reaction ----------
  pi.on("session_start", async (_event, ctx) => {
    let profile: Profile;
    try {
      profile = readProfile(ctx.cwd);
    } catch {
      // No profile yet — poller doesn't activate.
      return;
    }
    const flowLabels = collectFlowLabels(profile);
    const pollLabels = Array.from(flowLabels);

    // Reaction deps wired to real pi / gh / mutationRegistry.
    const reactionDeps: PollerReactionDeps = {
      isMutation: (issue, label) =>
        mutationRegistry.hasRecentMutation(issue, label),
      labels: {
        humanGate: [
          profile.labels.state.ready_for_human,
          profile.labels.state.needs_info,
          profile.labels.review.human,
        ],
        agentPickable: profile.labels.state.ready_for_agent,
        reviewHuman: profile.labels.review.human,
      },
      sendResume: async () => {
        // Trigger the loop to check for work on the next tick.
        // The reentrancy lock in runOneTick handles concurrent wakeups.
        if (afkState.isActive() && realDeps) {
          void runOneTick(realDeps);
        }
      },
      onFullyBlocked: async (issueNumbers) => {
        const n = issueNumbers.length;
        const msg = `pi-flow: ${n || "all"} issue${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} your attention`;
        ctx.ui.notify(msg, "info");
        pi.appendEntry("flow-attention", {
          ts: Date.now(),
          blockingIssues: issueNumbers,
        });
        // Post one comment per blocking issue (fire-and-forget, errors logged).
        for (const num of issueNumbers) {
          gh.commentOnIssue(
            num,
            `${profile.ai_disclaimer}\n\nThis issue is blocking the AFK loop. Human attention needed.`,
          ).catch((err: unknown) => {
            const msg2 = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`pi-flow: failed to comment on #${num}: ${msg2}`, "error");
          });
        }
      },
    };

    const onDiff = buildOnDiffHandler(reactionDeps, blockState);

    poller = createPoller({
      pollDeps: buildPollDepsFromPi(pi),
      pollOpts: { labels: pollLabels },
    });

    poller.onDiff(async (diffs: Diff[], snapshot: Snapshot) => {
      // Update module-scope snapshot (widget + next computeAssignable call).
      latestSnapshot = snapshot;
      refreshAfkWidget();
      // Update issue autocomplete cache if available.
      // (setFrom takes IssueLite which requires title; snapshot only
      // has IssueSnap — we skip for now, cache refreshes itself lazily.)
      await onDiff(diffs, snapshot);
    });

    poller.onError((err: unknown) => {
      const msg2 = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`pi-flow poller error: ${msg2}`, "error");
    });

    poller.start();
  });
}
