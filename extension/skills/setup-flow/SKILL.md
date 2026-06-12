---
name: setup-flow
description: Bootstrap a repo for the flow skill — adopt the pi-flow delivery loop via the typed setup tools and the /flow-setup wizard. Use when installing or configuring pi-flow in a repo, applying flow labels, scaffolding the flow profile, or installing the canonical issue templates.
---

# Setup flow

Bootstraps a repo so the **`flow`** skill works: applies the canonical labels, scaffolds
the **flow profile** (`.pi/flow.profile.md`), drops the GitHub issue-form templates into
`.github/ISSUE_TEMPLATE/`, and runs an end-to-end smoke test.

You almost always want **`/flow-setup`** (the interactive command) rather than calling the
individual tools by hand. The tools exist so an agent can drive setup non-interactively
when needed — most invocations should let the command orchestrate them.

## Tool inventory

The pi-flow extension registers these typed tools and one slash command. Reach for them
instead of shelling out to `gh` directly.

| Tool / command | What it does |
| --- | --- |
| `setup_flow_preflight` | Read-only check: `gh` is authed for github.com, and `origin` parses to `owner/repo`. Returns `{ok, ghAuthed, ghUser?, owner?, repo?, errors[]}` with codes `gh_not_authed` / `no_origin` / `unparseable_remote`. Call this first; if `ok:false`, stop. |
| `setup_flow_apply_labels` | Idempotent label bootstrap. Reads canonical labels from [labels.md](labels.md), creates only what's missing, **never edits or deletes**. Reports drift in `details.drift` without auto-correcting. `dryRun:true` lists would-creates. |
| `setup_flow_apply_issue_templates` | Copies the bundled YAML issue forms (triage / tracking / slice) from [issue-templates/](issue-templates/) into `.github/ISSUE_TEMPLATE/`. No commit — files left in the working tree. `overwrite:true` to replace existing. |
| `setup_flow_scaffold_profile` | Writes `.pi/flow.profile.md` from the canonical [profile-template.md](profile-template.md) plus answers (`owner`, `repo`, `defaultBranch`, optional scalars, optional `labelOverrides`). Round-trips through `flow_profile_read`. Refuses to overwrite unless `overwrite:true`. No commit. |
| `/flow-setup` | Interactive command that chains the four tools above into the full wizard. Procedural — drives `ctx.ui` dialogs directly, no LLM in the loop. |

## Using `/flow-setup`

The wizard has three modes, dispatched on its argument:

- **`/flow-setup`** (bare, fresh repo) — runs the full sequence: preflight → labels → interview → profile → issue templates → smoke test (`gh issue list -l ready-for-agent --limit 1`) → next-steps. On a repo that already has a profile, falls through to **edit mode** with a notice.
- **`/flow-setup --edit`** — opens a settings list (`ctx.ui.select` rows showing `<field>: <value>` plus Apply / Cancel). Selecting a row prompts for the new value; Apply re-writes the profile with `overwrite:true`. Never re-runs labels / templates / smoke.
- **`/flow-setup --reset`** — confirms with a warning, deletes `.pi/flow.profile.md`, then re-runs the fresh wizard.

All paths leave artefacts **uncommitted** on purpose. Tell the user to `git add` and
commit when they're happy.

## Driving setup non-interactively (agent path)

If you're operating without a UI (print mode, RPC, scripted run), call the tools in this
order yourself. Mirror what `/flow-setup` does:

1. `setup_flow_preflight` — bail if `ok:false`, surfacing every `errors[]` entry.
2. `setup_flow_apply_labels` — re-runnable; report `created` / `alreadyPresent` / `drift`.
3. `setup_flow_scaffold_profile` — pass `{ answers: { owner, repo, defaultBranch, ... } }`. If it returns `{written:false, reason:"exists"}`, do not retry with `overwrite:true` unless the user explicitly asked.
4. `setup_flow_apply_issue_templates` — same shape, same idempotency.
5. (Optional) Verify with `flow_profile_read` and a sanity `gh issue list -l ready-for-agent --limit 1`.

## Canonical data

Read these as the source of truth — the tools consume them, and edits to them flow
through automatically. **Do not** write to them as part of setting up a downstream repo
(they ship with the extension); edit only when you're changing the pi-flow defaults
themselves.

- [labels.md](labels.md) — canonical label vocabulary, parsed by `setup_flow_apply_labels`.
- [profile-template.md](profile-template.md) — body of every freshly-scaffolded profile.
- [issue-templates/](issue-templates/) — `triage.yml`, `tracking.yml`, `slice.yml` issue forms.

## Notes

- **Idempotent by design** — every tool is safe to re-run; gaps are filled, existing
  artefacts are left alone (or skipped with a reason).
- **No commits.** Every step that writes to the working tree leaves files for the user
  to inspect and commit themselves.
- **The `flow` skill** is what reads `.pi/flow.profile.md` once setup is done — its
  README is where the day-to-day operating model lives (ADR-0022 for the triage core,
  ADR-0036 for the autonomous-track lifecycle).
