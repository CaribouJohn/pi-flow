---
name: setup-flow
description: Bootstrap a repo for the flow skill — scaffold its flow profile and create the canonical labels on the tracker. Use when installing or configuring the flow delivery-lifecycle state machine in a repo, setting up flow labels, or creating docs/agents/flow-profile.md.
---

# Setup flow

Bootstraps a repo so the **`flow`** skill works: scaffolds the **flow profile** it reads
(`docs/agents/flow-profile.md`) and creates the **canonical labels** on the tracker.
**Idempotent** — safe to re-run; it only fills gaps and reports what it did, never
clobbering an existing profile or label.

## Steps

1. **Detect the tracker.** Read `git remote get-url origin`. GitHub (via `gh`) is the only
   supported tracker today — if it isn't GitHub, say so and stop. Capture `owner/repo`.

2. **Scaffold the profile** at `docs/agents/flow-profile.md`:
   - If it **already exists**, do **not** overwrite — report it and continue (offer a diff
     against [profile-template.md](profile-template.md) only if asked).
   - Otherwise write it from [profile-template.md](profile-template.md), substituting
     `{{REPO}}` with `owner/repo`, and fill the **Track execution** placeholders (verify-gate
     command, the in-situ verification harness, the reviewer-agent command) for this repo.
     Ask whether the tracker uses different label strings than the canonical role names; the
     default is **canonical == actual**, so usually no edit is needed.

3. **Create the labels.** For each entry in [labels.md](labels.md): check whether it exists
   (`gh label list`), and `gh label create <name> --color <hex> --description "<desc>"`
   **only if missing**. Never edit or delete an existing label — report it as "already
   present". Summarise created vs existing.

4. **Verify the skill.** Confirm the `flow` skill resolves — the profile is inert without it.
   If absent, tell the maintainer to install it.

5. **Report.** A short summary: profile written or skipped, labels created vs already there,
   and the next step — `/flow what needs attention?`.

## Notes

- **Idempotent by design** — re-running fills gaps only; never clobbers. Safe on a partially
  set-up repo.
- **No issue migration.** This sets up the machine; moving an existing repo's issues onto it
  is a separate task.
- The profile is the source of truth the `flow` skill reads — see that skill's README for the
  rationale (ADR-0022 for the triage core, ADR-0036 for the autonomous-track lifecycle).
