# ADR-0022: Triage state machine — decisions are labels, volatile states are derived

## Status

Accepted. **Extended by ADR-0036** (autonomous feature-track execution: human bookends,
agent-gated merges, a track branch — adds the `needs-plan-review` / `needs-acceptance`
roles and flips the `review:` default to agent). The profile this ADR calls
`triage-profile.md` is now `docs/agents/flow-profile.md`, read by the `/flow` skill
(renamed from `triage-process`).

## Context

Triage runs on a small label-based state machine (originally five roles:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`),
inherited from the generic `triage` / `github-triage` skills and mapped to our label
strings in `docs/agents/triage-profile.md`. We layered an `effort:` axis on top
(ADR-precedent: track effort, **not** the target model, because the model roster
churns faster than the issues and any model label is stale by the next release — a
re-label sweep we explicitly refuse).

Two gaps surfaced while planning a multi-issue track (the server-authorization
foundation, #263–#266):

1. **`ready-for-human` was overloaded.** It conflated two unrelated human jobs:
   *implement this by hand* and *this is too big — decompose it into agent-ready
   slices*. At a glance you couldn't tell "I hand-code this" from "I `/to-issues`
   this." The generic skills had no state for "container that tracks children"
   either, even though their own docs describe "child issues under a tracking parent."

2. **Several states people wanted to track are volatile and derivable.** "Blocked"
   is just an unmet `Depends on: #n`. "In progress", "implemented", "reviewed" are
   readable from the assignee and the linked PR. Hand-maintaining labels for these
   reintroduces exactly the stale-label re-sweep we rejected for model labels — and
   far more often, since they flip on every dependency close and PR transition.

Separately, review routing (should an **agent** or a **human** review the PR?) is a
genuine policy that GitHub *cannot* derive — review-requests target people, not "an
agent".

We also wanted the machine to be (a) readable by every agent harness, not just
Claude Code; (b) human-readable with a diagram; and (c) portable — "refined in this
repo, but more generally practical" — without baking Hiss specifics into the
user-global, re-installable generic skills (editing those is clobbered by
`/setup-matt-pocock-skills` and would leak Hiss states into unrelated repos).

## Decision

**1. Extend the role axis; split the overloaded role.**
Add `needs-slicing` (too big/fuzzy — decompose via `/to-issues`) and `tracking` (a
container parent, never worked directly). Narrow `ready-for-human` to **implement-only**.
An over-large issue flows `needs-slicing` → (`/to-issues`) → `tracking` + child leaves.

**2. Review routing is an orthogonal policy axis, not a state.**
`review:agent` / `review:human`, sitting alongside the role like `effort:` does.
"Waiting for agent review" is then derived (open PR + `review:agent`).

**3. Volatile/derivable states are derived, never hand-labelled.** Generalising the
"track the intrinsic property, not the dispatch-time/volatile one" principle:

| Derived state | Source of truth |
| --- | --- |
| blocked | unmet `Depends on: #n` |
| in-progress | the issue's **assignee** (a tool/human self-assigns to claim a `ready-*` issue) |
| implemented | linked PR open |
| reviewed | linked PR approved / merged |

No `blocked` / `implemented` / `reviewed` labels are created. A future automation
*may* mirror these onto labels from their sources, but they are never set by hand.

**4. The machine lives in a repo-local project profile; the skill is generic.**
`docs/agents/triage-profile.md` (now `flow-profile.md`) holds all repo specifics (tracker
access, label mapping, the axes, the derived-state rules, the Mermaid diagram). The skill
carries the *machine* and reads the *profile* — so it stays portable and never
clobbers other repos. The profile supersedes the generic `triage` / `github-triage` /
`triage-issue` skills for this repo. Intent: refine the skill repo-locally first, then
contribute it upstream once proven.

## Consequences

- **One-glance triage queues** become single-label reads: `needs-slicing` = my
  decomposition queue · `ready-for-agent` = agent-assignable · `ready-for-human` =
  I hand-code it · `tracking` = container. "Agent-assignable *now*" additionally
  subtracts issues with an open `Depends on:` (the derive step).
- **No re-label sweeps** for dependency/PR churn — the cost we refused for model
  labels does not reappear. The trade-off: "blocked"/"reviewed" aren't visible as
  board labels until/unless the automation lands.
- **An automation engine is now a dependency for board visibility** (derive
  blocked/implemented/reviewed from `Depends on:` + PR state). Filed as its own
  `needs-slicing` issue; until it exists, those states are read off the source.
- **`assignee` carries semantic weight** — self-assignment is the in-progress signal a
  dispatcher reads to avoid double-picking a `ready-*` issue.
- **The generic triage skills are superseded here, not edited.** Avoids the
  clobber/leak problem; the cost is a repo-local profile (and, later, a repo-local
  skill) to maintain.
- **Portability is designed in** — Hiss specifics are confined to the profile, so the
  skill can be generalised/upstreamed without carrying this repo's vocabulary.
