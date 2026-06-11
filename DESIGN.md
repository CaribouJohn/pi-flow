# pi-flow — Extension Design

A pi extension that implements the `flow` and `setup-flow` skills as a **full
delivery engine**, optimised for an AFK agent driving development with the human
checking in occasionally.

## Goal

Let the user fire `/flow afk`, walk away, and come back to find as much work
done as the state machine and human gates permit — with anything genuinely
requiring human input parked cleanly on labels in GitHub, ready to resume the
moment the human moves it.

## Shape

**Full engine (option C).** Ships the existing skills as prompts, registers
deterministic typed tools for every state mutation, owns a status widget +
autocomplete, runs a continuous AFK loop driven by GitHub label state.

## Tracker

**GitHub only**, via the `gh` CLI, for v1. All tracker calls go through a
single internal module so a future GitLab/Linear adapter could slot in, but no
interface gymnastics for v1.

---

## Architecture — three-layer topology

```
AFK loop  (the main pi session you launched)
  orchestrator
    ├─ owns the GitHub poller
    ├─ owns flow state-machine mutations
    ├─ owns the status widget
    └─ for each pickable slice:
        ├─ spawns Implementer sub-session  (ctx.newSession, fresh context)
        │     └─ implements the slice on a slice branch off the track branch
        │     └─ runs flow_verify (inline tool, shells out to verify-gate cmd)
        │     └─ returns { branch, commitSha, verifyResult } to orchestrator
        └─ spawns Reviewer sub-session     (ctx.newSession, fresh context)
              └─ runs the profile's reviewer command (default /code-review)
              └─ posts a comment on the PR/issue
              └─ returns { verdict, comments[] } to orchestrator
```

**Why three layers:** keeps the orchestrator's context lean across many slices
— it only sees tombstones (`slice #270: implemented ✓, reviewed ✓, merged`),
not every diff. Enforces the implementer↔reviewer separation structurally
(fresh context is a `ctx.newSession` guarantee, not an honour system).

**Reviewer iteration:** implementer ↔ reviewer ping-pong up to **N rounds**
(profile-configurable, default 2). On the (N+1)th rejection the orchestrator
relabels the slice `review:human` and the poller picks it up when you act.

**Reviewer verdict shape:**
```ts
{ verdict: "approve" | "changes-requested" | "escalate", comments: string[] }
```

**Verify gate:** inline tool `flow_verify` from the implementer — shells out
the profile's `verify_gate` command, returns pass/fail + captured output. No
agent layer around it; it's deterministic.

---

## Config — `.pi/flow.profile.md`

Markdown with YAML frontmatter. Frontmatter is the machine-readable contract;
prose below is what the LLM reads when running `/flow ...`.

```md
---
tracker: github
repo: owner/name                    # auto-detected at setup
default_branch: main
track_branch_prefix: track/
verify_gate: bun test
in_situ_harness: bun .pi/extensions/electrobun-dev/cdp.ts snapshot   # optional
reviewer_command: /code-review
reviewer_iteration_cap: 2
poll_cadence_seconds: 30
ai_disclaimer: "🤖 Posted by pi-flow on behalf of @johnh"
labels:
  category: [bug, enhancement, chore, spike]
  state:
    needs_triage: needs-triage
    needs_grilling: needs-grilling
    needs_slicing: needs-slicing
    needs_plan_review: needs-plan-review
    tracking: tracking
    ready_for_agent: ready-for-agent
    in_progress: in-progress
    needs_acceptance: needs-acceptance
    needs_info: needs-info
    wontfix: wontfix
  effort: [xs, s, m, l]
  review: { agent: review:agent, human: review:human }
---

# Flow profile

(Prose ported from setup-flow/profile-template.md — state machine narrative,
role definitions, derived states, at-a-glance queries. This is what the LLM
reads.)
```

---

## Tool surface

All mutating tools update the local snapshot optimistically **and** record a
mutation token (see AFK loop).

| Tool                              | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `flow_profile_read`               | Return parsed profile (frontmatter + prose)                          |
| `flow_issues_query(state, extra)` | `gh issue list -l <label>` with optional extra filters               |
| `flow_next_assignable(track?)`    | Derived: `ready-for-agent` + no open `Depends on:` deps              |
| `flow_set_state(issue, from, to)` | Atomic label swap. **Refuses illegal transitions** per state machine |
| `flow_issue_create(template, …)`  | Create issue from a TEMPLATES.md template, apply labels              |
| `flow_track_open(parent)`         | Create the track branch, file the acceptance bookend                 |
| `flow_track_status(parent)`       | Slice rollup for a `tracking` parent                                 |
| `flow_verify`                     | Run the profile's `verify_gate` command, return pass/fail + output   |
| `flow_comment(issue, body)`       | Comment with AI disclaimer auto-prefixed                             |
| `flow_review_spawn(slice)`        | Orchestrator-only: spawn reviewer sub-session, await verdict         |
| `flow_implement_spawn(slice)`     | Orchestrator-only: spawn implementer sub-session, await result       |
| `setup_flow_apply_labels`         | Idempotent `gh label create` for the canonical taxonomy              |
| `setup_flow_scaffold_profile`     | Write `.pi/flow.profile.md` from template + interactive answers      |
| `setup_flow_apply_issue_templates`| Drop `.github/ISSUE_TEMPLATE/*.yml` for triage/track/slice           |

**State-transition validation:** `flow_set_state` refuses illegal transitions.
The state machine — states, transitions, derivation rules, and which states are
human-gated vs agent-pickable — is encoded in the extension (`state-machine.ts`),
not the profile. The profile only renames labels. This is a deliberate v1 call:
the AFK loop's exit condition and the reviewer-escalation contract depend on a
fixed spine, and we'd rather ship one opinion than a half-flexible one.

**v2 path (not built):** allow the profile to *extend* the core machine with
repo-specific states (e.g. `needs-security-review`) by declaring a `role`
(`human-gated` / `agent-pickable` / `terminal`) and an `inserts_between` pair of
core states. The extension would validate the extension at profile load. Core
states remain immutable. Worth doing the moment a second adopter wants an extra
gate; not worth doing speculatively.

**Self-escalation whitelist:** the LLM-side agents may move issues into
`needs-info` or `review:human` from any agent-owned state, with a reason
recorded in a comment. Other transitions require human action.

---

## UI surface

### Status widget (always visible while flow is active)

```
flow · 2 tracks live · next: #270 (s) · 1 needs-acceptance · 1 review:human · idle 14m
```

Updated on every poll and every mutating tool call.

### Autocomplete

`#NNN` issue-number completion in the editor, like `github-issue-autocomplete`,
filtered by default to all open flow-labelled issues, with a fast local fuzzy
match over `gh issue list` results cached on `session_start` and refreshed by
the poller.

### Non-LLM commands

| Command         | Action (no agent invocation)                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `/flow status`  | Print current track summary + what's blocked on what                                  |
| `/flow next`    | Print next assignable slice across all tracks                                         |
| `/flow setup`   | Run the setup-flow wizard (interactive — only command that uses `ctx.ui` dialogs)    |
| `/flow afk`     | Enter AFK mode (starts the loop + poller)                                             |
| `/flow afk stop`| Exit AFK mode (stops loop + poller, leaves state intact)                              |

### Dialogs

Only used inside `/flow setup`. **No `ctx.ui.confirm` in the flow loop.** AFK
means no human is there to click.

---

## AFK loop

### Trigger

`/flow afk` (or eventually a `--flow-afk` startup flag). Persists "AFK on
these tracks" via `pi.appendEntry` so state survives `/reload`. Across pi
restarts: **resume on demand** — status widget shows `AFK paused · /flow afk to
resume`.

### Loop

1. Orchestrator picks `flow_next_assignable` across **all open tracks**
   (round-robin, wide scope).
2. Spawn implementer sub-session; await result.
3. Spawn reviewer sub-session; await verdict.
4. On `approve`: merge slice into track branch (agents never touch `main`).
5. On `changes-requested` (under cap): bounce back to implementer with the
   verdict.
6. On `changes-requested` (cap exceeded) or `escalate`: relabel `review:human`,
   surface in widget, move on to the next assignable.
7. When no assignable slice remains across any track: enter **blocked-idle**
   — loop sleeps, poller stays alive.

### GitHub poller — the AFK heartbeat

- **One `gh` call per tick:** `gh issue list --label <our-labels> --json number,labels,updatedAt,state` plus `gh pr list --json number,state,closingIssuesReferences` for PR-merge signals.
- **Scope:** wide — all flow-labelled issues in the repo, so newly human-filed
  triage work gets picked up without being told.
- **Cadence:** 15s for the first 5 minutes after blocking, 60s thereafter.
- **Signals that count as "human moved it":** label changes, issue open/close,
  PR merge that closes a linked flow issue. **Not** raw comment text in v1.
- **Diff vs cached snapshot:** when a watched issue's labels drop a
  human-gate label or gain an agent-actionable one, fire
  `pi.sendUserMessage("/flow afk resume", { deliverAs: "followUp" })`. Pi
  queues it if mid-turn; runs it if idle.

### Agent-vs-poller race — mutation tokens

Every mutating `flow_*` tool:
1. **Optimistically updates** the local snapshot with the new state.
2. **Records a mutation token** `{issue, label, ts}` in a 10-second-TTL buffer.

The poller ignores diffs that match a recent mutation token within the TTL.
Optimistic update is the primary defence; mutation tokens cover the
`gh`-eventual-consistency window.

### Surfacing "needs human" when you walk back

All of:
- Status widget (continuously)
- `ctx.ui.notify` one-shot OS notification when the loop first transitions to
  fully-blocked
- A `flow_attention` session entry written inline so scrollback shows the gate
- An AI-disclaimer-prefixed comment on the issue tagging the human, so it's
  visible on the GitHub side too

---

## `/flow setup` wizard

Runs once per repo (re-runnable in edit mode). Only command in the extension
that uses `ctx.ui` dialogs.

### Steps

1. **Preflight** — check `gh auth status`, detect repo from git remote, fail
   fast with actionable error if either is missing.
2. **Apply canonical labels** — `setup_flow_apply_labels` (idempotent).
3. **Interview** — `ctx.ui.input` / `select` for every frontmatter field with
   a default. Probes the repo for sensible defaults (e.g. default branch).
4. **Write profile** — `.pi/flow.profile.md` with frontmatter + prose ported
   from `setup-flow/profile-template.md`.
5. **Apply issue templates** — `.github/ISSUE_TEMPLATE/*.yml` for triage,
   tracking, slice. (Yes.)
6. **Smoke test** — `gh issue list -l ready-for-agent --limit 1` to prove
   labels + auth work end-to-end.
7. **Print next steps** — pointer to `/flow triage #N` and `/flow afk`.

### Not done by setup

- No ADR scaffold.
- No `CONTRIBUTING.md` edits.
- No auto-commit. Files are left in the working tree for the user to commit.

### Re-run / patch

If `.pi/flow.profile.md` exists: **edit mode** — presents a settings list of
all current values, user toggles/edits any field. `--reset` to nuke and rerun
the full wizard from scratch.

---

## Extension layout

```
pi-flow/
├── DESIGN.md                          # this file
├── extension/
│   ├── index.ts                       # entry: wires everything together
│   ├── profile.ts                     # parse / write .pi/flow.profile.md
│   ├── state-machine.ts               # legal transitions, derivation rules
│   ├── gh.ts                          # all `gh` CLI calls in one module
│   ├── tools/
│   │   ├── flow-*.ts                  # one file per flow_* tool
│   │   └── setup-flow-*.ts            # one file per setup_flow_* tool
│   ├── afk/
│   │   ├── loop.ts                    # orchestrator loop
│   │   ├── poller.ts                  # GitHub polling + diff
│   │   ├── mutation-buffer.ts         # mutation token TTL buffer
│   │   └── sub-sessions.ts            # implementer / reviewer spawn helpers
│   ├── ui/
│   │   ├── widget.ts                  # status widget
│   │   ├── autocomplete.ts            # #NNN issue autocomplete
│   │   └── setup-wizard.ts            # /flow setup interactive flow
│   └── commands.ts                    # /flow status, /flow next, /flow afk, /flow setup
└── claude-skills/                     # existing skills, shipped to LLM via resources_discover
    ├── flow/
    ├── setup-flow/
    └── electrobun-dev/
```

The extension registers `claude-skills/` as a skill path via
`resources_discover`, so `/flow` (the skill) remains the LLM-facing prompt and
the extension's typed tools are what the skill instructs the LLM to call.

---

## Out of scope for v1

- Profile-extensible state machine (v1 is code-only; see Tool surface for the v2 path)
- Trackers other than GitHub
- Webhook ingestion (polling only)
- Comment-text parsing as an unblock signal ("go ahead" in a comment)
- Auto-resume across pi restarts
- ADR scaffolding inside `/flow setup`
- Reviewer model differing from implementer model (one model registry shared)
- Multi-repo AFK in a single session
