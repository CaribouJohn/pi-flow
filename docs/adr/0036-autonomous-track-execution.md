# ADR-0036: Autonomous feature-track execution — human bookends, agent-gated merges, a track branch

## Status

Accepted — extends ADR-0022 (the triage state machine) and scopes ADR-0001
(PR-only workflow). The operational embodiment is the `/flow` skill (formerly
`/triage-process`); the repo specifics live in `docs/agents/flow-profile.md`.

## Context

ADR-0022 built a label-driven triage machine on an assumption baked in from the
generic skills it descended from: **a human reviews every PR**. The `review:human`
label was the routing signal, and ADR-0001 made the maintainer's merge of each PR
into `main` the *"cheapest place to catch a bad AI-generated change before it
becomes the new baseline."* Both rested on two premises that have quietly gone
stale:

1. **The executing agent couldn't see or drive the app.** `agent-ready-issues.md`
   designed for a "won't explore, can't see the UI" floor, so any UI-bearing or
   product-sensitive slice defaulted to `review:human` — a human had to eyeball it.
2. **The human was the only independent reviewer available.** ADR-0001's value is
   really *an independent set of eyes that didn't write the code*; "human" was just
   the only such reviewer on hand.

This session falsified both. An agent implemented a slice (#397) **and** verified
it in situ — drove the real WebView2 app over CDP via the `electrobun-dev` skill,
took screenshots, read the console and the on-disk transcript, confirmed no
regression across a restart. A *separate* reviewer agent can supply the independent
review pass ADR-0001 actually wanted (`/code-review`, fresh context). What remained
irreducibly human shrank to two things: a **product/taste judgment** on the result,
and the **final merge to `main`**.

Yet the whole assistant-conversation track (#397, #404, #399–#407, #398, #401) was
**blanket-labelled `review:human`**. In practice #397 was agent-implemented,
agent-verified in situ, and merely human-approved at the merge button. The label
over-applied: it bundled "a human must judge the product" (irreducible) with "a
human must read the diff / verify it works" (now agent-doable) and "a human owns the
merge" (an ADR-0001 constant, independent of any review label).

## Decision

**1. Human-in-the-loop collapses to two bookends per feature track.** A (usually
agent-routed) **plan gate** at the front and a **human acceptance gate** at the
back. The autonomous middle — implement → review → merge — needs no human. The
human spends judgment only where it is irreducible: the rare plan-review escalation,
and final acceptance.

**2. An independent reviewer agent — not the implementer — gates each slice merge.**
This preserves ADR-0001's real property (an independent catch-point that did not
write the code) while swapping the *who* from human to a fresh-context reviewer
agent. The implementer self-certifying is **insufficient**: it shares the blind
spots that produced the defect (a dropped safeguard it didn't think of, it won't
think of on review either). In-situ verification proves *"it works"*; the
independent reviewer is what still catches *"this quietly introduced a premature
abstraction"* or *"slice 4 dropped slice 2's safeguard."*

**3. A feature-track branch; agents never touch `main`.** A track gets one branch
off `main`. Slice PRs branch off the **track branch** and merge into it
(reviewer-agent-gated, agent-merged). Only the **track branch** PRs off `main`, and
only the **maintainer** merges it — after the acceptance gate. So ADR-0001's
load-bearing clause ("changes land on `main` through a PR the maintainer merges")
stays literally true at the `main` boundary, and `main` stays *accepted-features-
only*. The intermediate slice merges are into the track branch, which ADR-0001 does
not govern.

**4. Two new roles + a `review:` default-flip (extends ADR-0022).**

- **`needs-plan-review`** — a parent (tracking) front-gate state: the slices are
  drafted but the track is not yet cleared to run.
- **`needs-acceptance`** — the role of the single back-gate child issue: verify and
  accept the integrated feature. Distinct from `ready-for-human` (which ADR-0022
  deliberately narrowed to *implement-only*); acceptance is neither implementing nor
  "too big".
- The **`review:` default flips**: `review:agent` (an independent reviewer agent
  gates the merge) becomes the **default**; `review:human` becomes the
  **exception** — escalate *this* slice to a human reviewer, on the same trigger
  logic as the plan gate (`effort:`/content smell).

**5. Plan-review routing.** After `/to-issues`, the parent enters
`needs-plan-review` (not straight to `tracking` as before). A reviewer agent
validates each child against the agent-ready contract (`agent-ready-issues.md`) and
judges decomposition risk from `effort:` + content. **Default → it advances the
parent to `tracking` (running)** and the autonomous loop begins. **Escalate → it
leaves the track in `needs-plan-review` and pings the maintainer** — reserved for
smells: an `effort:high` leaf, an ADR-conflicting area, an irreversible migration, a
security surface. The human gate exists but is the exception branch, not a station
every track stops at.

**6. The `/flow` skill is the operational embodiment.** `/triage-process` is renamed
`/flow` and rewritten to drive the whole lifecycle conversationally — *"`/flow`
what's ready to triage"*, *"`/flow` work the agent-ready tasks"*. The repo profile
(`flow-profile.md`) still holds every specific (branch naming, merge policy,
reviewer-agent + verification invocation), so the skill body stays portable and free
of repo vocabulary, exactly as ADR-0022 intended.

## Consequences

- **The maintainer's per-slice toil disappears.** They author the decomposition
  (slicing is the front human touchpoint) and accept the integrated result; the
  middle runs unattended.
- **`main` stays clean — accepted features only — without long-lived stacked PRs.**
  The no-stacking rule is *scoped, not deleted*: within a track, slices branch off
  the track branch; only the track branch PRs off `main`. A chain of dependent
  *open* PRs across unrelated concerns is still forbidden.
- **The reviewer agent is now load-bearing for correctness.** Its independence
  (fresh context, did not write the code) is the safety property — so it must never
  be the implementing agent.
- **A defect caught only at acceptance is costlier to unwind than per-slice** — but
  the per-slice reviewer-agent gate keeps that rare; acceptance is a backstop, and a
  rejection there produces corrective issues on the track branch *before* it reaches
  `main`.
- **Long-lived track branches risk drift** against a moving `main`; mitigated by
  keeping tracks short (the point of vertical slices) and merging `main` into the
  branch periodically (merge, not rebase, so the agent-merged history stays stable).
- **ADR-0001 is scoped, not overturned**: the maintainer still merges `main`; agents
  merge only the track branch. **ADR-0022's `review:` axis is re-pointed** and the
  machine grows two roles.

## Alternatives considered

- **Slices agent-merge straight to `main`; acceptance post-hoc.** Rejected — breaks
  "the maintainer merges `main`", leaves unaccepted code live, and makes a rejection
  a revert rather than a fix-before-landing.
- **A track integration branch is overkill; just keep per-PR human merge but
  lighter.** Rejected by the maintainer — the goal is to *stop seeing intermediate
  PRs*, not to do less work on each.
- **The implementer self-certifies (no separate reviewer agent).** Rejected — same
  blind spots; loses the independence that was ADR-0001's actual value.
- **Keep the blanket `review:human` status quo.** Rejected — it over-applies the
  human to slices with no taste call and to verification the agent can now carry.

## Open questions

- The reviewer-agent **escalation heuristic** — which content smells (beyond
  `effort:high`, ADR-conflict, irreversible migration, security) warrant a human —
  will firm up with use.
- **Drift tolerance** for longer tracks, and whether to automate the periodic
  `main`-into-branch merge.
- Whether plan-review should also lightly vet **decomposition soundness** (slice
  boundaries/order), or stay a pure agent-ready *contract* check.
- How the dispatcher **selects a model per `effort:`** inside the autonomous loop.
- Whether the **derived-state automation** (ADR-0022's open dependency) should now
  also drive the autonomous loop's "what's assignable next" directly.
