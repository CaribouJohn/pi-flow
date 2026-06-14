# ADR-0037: `needs-grilling` — a design-grill state, distinct from slicing

## Status

Accepted — extends ADR-0022 (the role machine) and refines ADR-0036's front
bookend. Operational truth lives in `docs/agents/flow-profile.md`; the `/flow`
skill surfaces and hands off the state but never performs the grill.

## Context

ADR-0036 framed the lifecycle as two human bookends with an autonomous middle, and
named the front-bookend human work loosely as "triage + slice." But three distinct
front activities were collapsed into two states:

1. **Disposition** — "what is this?" → `needs-triage` (the inbox, auto-stamped on
   every new issue).
2. **Design grill** — interview a big, *undecided* thing into a shape (a PRD and/or
   an ADR) before it can be sliced. Done in practice — ADR-0034 and ADR-0036 both came
   out of `/grill-with-docs` — but **invisible to the machine**.
3. **Slice** — decompose the understood thing → `needs-slicing` → `/to-issues`.

`needs-slicing` silently assumed "understood enough to slice," and `/to-issues` on a
*not-yet-understood* feature produces bad slices. The design grill — a deep human
interview that is a **precondition** for good slicing — had no state, so "what needs
my design attention" wasn't a surfaceable queue distinct from "what's ready to
decompose."

## Decision

**1. Add `needs-grilling`** — a front-bookend role between `needs-triage` and
`needs-slicing`: "this is big and the solution is *undecided*; a human must run a
design grill and produce the design artifact (a PRD and/or ADR) before it can be
sliced."

**2. The trigger is "is the solution undecided?", not the category.** Category is a
strong *signal*, not a gate: most enhancements take the grilling path; most bugs are
understood and go straight to `needs-slicing` or `ready-for-agent`. But a design-laden
*architectural bug* (e.g. "reconciliation drops messages under concurrency") routes to
`needs-grilling`, and a trivial enhancement ("add a `--danger` token") skips it. Triage
picks the path on "needs design?", never on bug-vs-enhancement alone.

**3. The PRD/ADR is the exit artifact, not a state.** `needs-grilling` *is* "interview
it (`/grill-with-docs` or `/grill-me`) → produce the design artifact (`/to-prd` and/or
an ADR)." You leave `needs-grilling` the moment that artifact exists. There is no
`needs-prd` state — that would be over-granular. `needs-grilling` mostly exits to
`needs-slicing`, but may resolve to `ready-for-agent` (the grill shrank it to a leaf),
`ready-for-human`, or `wontfix` (the grill killed it).

**4. `/flow` surfaces and hands off; it never grills.** A grill is an interview *with*
the maintainer, so `/flow` cannot perform it. It surfaces the `needs-grilling` bucket as
human work and hands off to the **specific** skill — `/grill-with-docs` for design that
must reconcile against the domain model + ADRs (the default for a feature), `/grill-me`
for a lighter plan stress-test, then `/to-prd` to capture the result — and picks the
thread back up at `needs-slicing` (`/to-issues`) once the artifact exists.

## Consequences

- The human's front-bookend **design** work becomes a first-class, surfaceable queue,
  distinct from the mechanical **slicing** queue.
- One new label/role; the machine grows by one state. Justified: the grill is a real
  precondition for good slicing that was happening invisibly.
- `needs-slicing` now honestly means "understood — decompose it"; the grilling
  precondition is explicit upstream of it.
- Category stays a heuristic, so a design-laden bug isn't forced down the
  bug-skips-grilling path, nor a trivial enhancement through a pointless grill.

## Alternatives considered

- **Rename `needs-triage` → `needs-grilling`.** Rejected — `needs-triage` is the inbox
  (auto-stamped on every new issue by `triage-label.yml`); most issues need only a quick
  disposition, not a design interview. The rename asserts every incoming issue is a
  design project.
- **Fold "grill first if undecided" into the `needs-slicing` workflow (no new state).**
  Rejected — loses the surfaceable "needs my design attention" queue and keeps the grill
  invisible; `needs-slicing` keeps conflating "design it" with "decompose it."
- **A separate `needs-prd` state after grilling.** Rejected — the PRD is the grill's
  *output*, not a distinct activity.
