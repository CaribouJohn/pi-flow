---
name: flow
description: Drive a project's whole delivery lifecycle from a repo profile — triage, hand off a design grill, decompose, a plan-review gate, autonomous build/review/merge of a feature track, and a human acceptance gate. Use when the user wants to see what needs attention, triage an issue, route something to a grilling/design session, decompose an issue, find what's ready to pick up, work the agent-ready tasks of a track, run the plan-review or acceptance gate, or move an issue through its workflow states.
---

# Flow

A **portable** delivery-lifecycle skill. The state machine is **not** in this skill — it
lives in the repo's **flow profile** (by convention `.pi/flow.profile.md`). Read
the profile first, every session: it defines the tracker and how to reach it, the
**role↔label mapping**, the axes (`effort:`, `review:`), the **derived-state rules**, the
**track-execution** model (branch/merge/reviewer-agent), the state machine, and the
conventions (AI disclaimer, out-of-scope store). This skill carries only the *behaviour*;
the profile carries the *specifics*. Role names below are **canonical** — resolve them to
the repo's actual label strings via the profile's mapping. **If no profile exists, say so
and stop — never invent labels.**

## Quick start

1. Read the profile (`.pi/flow.profile.md`).
2. Interpret the maintainer's request and act — e.g. "what needs attention?", "let's look
   at #42", "what's ready to pick up?", "work the agent-ready tasks", "run the plan gate on
   #268", "accept the track".
3. Prefix **every** comment or issue you post with the profile's AI disclaimer.

The lifecycle, end to end: **triage → decompose → plan-review gate → autonomous
build/review/merge of the track → acceptance gate**. The human sits at two bookends (the
plan-gate escalation and acceptance); the middle runs unattended.

## Workflow: show what needs attention

Query the tracker and present, oldest-first with counts + a one-line summary each, the
buckets that await the maintainer: unlabeled, `needs-triage`, `needs-info` with reporter
activity since the last note, **`needs-grilling` (await your design session)**,
**`needs-plan-review` tracks the agent escalated**, and **`needs-acceptance` issues whose
slices are all merged**. Let the maintainer pick one.

## Workflow: triage one issue

1. **Gather context** — read the full issue + comments + any prior triage notes. Explore
   the codebase using the project's domain glossary; respect ADRs in the area. Check the
   out-of-scope store for a prior rejection that resembles it.
2. **Recommend** — present one **category** + one **role** recommendation with reasoning and
   a short codebase summary, then wait. Reproduce bugs first when you can.
3. **Apply** the agreed transition (consult the profile's state machine; flag unusual ones).
   See [TEMPLATES.md](TEMPLATES.md) for the brief / notes shapes.
   - `ready-for-agent` → post an agent brief; add an `effort:` label. `review:agent` is the
     **default** (the profile's reviewer-agent gate) — set `review:human` only to escalate.
   - `ready-for-human` → a leaf a human must **physically** do (judgment, external access,
     manual/native work); brief noting why (**implement-only**). First check it isn't HITL
     *only because a decision is undecided* — if so, **grill the decision out and it becomes
     `ready-for-agent`** (most apparent-HITL is an unresolved decision, not human-only
     execution; resolve it once, in a grill, and embed the answer in the brief).
   - `needs-grilling` → big **and the solution is undecided**: see *grilling handoff* below.
   - `needs-slicing` → big **but understood**: see *decompose* below.
   - `needs-info` → post the triage-notes template with questions for the reporter.
   - `wontfix` → explain; for enhancements write the out-of-scope store, then close.

   The big-issue split is "is the *solution* undecided?", **not** the category (ADR-0037):
   solution-undecided → `needs-grilling` (usually enhancements, also a design-laden
   architectural bug); understood-but-big → `needs-slicing` (usually bugs).

## Workflow: grilling handoff (needs-grilling → needs-slicing)

A **front bookend**, and the maintainer's design work. `/flow` **never runs the grill** —
a grill is an interview *with* the maintainer. It **surfaces and hands off**:

1. Confirm the issue is `needs-grilling` (big + solution undecided). If the design is
   actually settled, it should be `needs-slicing` instead.
2. **Hand off to the specific skill** — `/grill-with-docs <ref>` when the design must
   reconcile against `CONTEXT.md` + the ADRs (the default for a feature), or `/grill-me`
   for a lighter plan stress-test. The grill's **output** is the design artifact: a PRD
   (capture it with `/to-prd`) and/or an ADR.
3. When the artifact exists, the issue **leaves `needs-grilling`** — usually to
   `needs-slicing` (now sliceable → *decompose* below), occasionally to `ready-for-agent`
   (the grill shrank it to a leaf), `ready-for-human`, or `wontfix` (the grill killed it).

## Workflow: decompose (needs-slicing → needs-plan-review)

When an issue is too big/fuzzy, label it `needs-slicing` and run `/to-issues` to create the
child slices. **`/to-issues` only creates children — it never touches the parent.** After it
returns, *this skill* relabels the parent **`needs-plan-review`** (clearing `needs-slicing`)
— **not** straight to `tracking` (ADR-0036): a freshly-sliced track must pass the plan gate
before it runs. **Never fork `/to-issues` to do this** — the parent transition is a flow
concern, not a slicing one. Also file the track's **acceptance issue** (`needs-acceptance`,
`review:human`, `Depends on:` every slice) — the back bookend — as part of the same step.

## Workflow: plan-review gate (needs-plan-review → tracking)

The **front bookend**. For a parent in `needs-plan-review`:

1. **Validate each child against the agent-ready bar** the profile points at — exact files,
   no open design calls, a named verification method. A child that misses it goes back for a
   rewrite (or `ready-for-human`).
2. **Judge decomposition risk** from `effort:` + content. **Escalate to the maintainer**
   (leave the parent in `needs-plan-review`, post a note naming the risk) on a smell: an
   `effort:high` leaf, an ADR-conflicting area, an irreversible migration, a security
   surface. Otherwise **clear it** — advance the parent to `tracking` and create the **track
   branch** per the profile's branch model.

A cleared track is ready for autonomous execution.

## Workflow: work the track (the autonomous middle)

For a `tracking` parent, drive its slices to done **without the human**, per the profile's
track-execution model. Loop until no assignable slice remains:

1. **Pick the next assignable slice** = `ready-for-agent`, no open `Depends on:` (the derive
   step). Self-assign it (the in-progress signal).
2. **Implement** it on a slice branch off the **track branch**; get the **verify gate**
   green. For a UI-bearing slice, **verify in situ** via the profile's real-app harness
   (`electrobun-dev`) and capture the evidence.
3. **Independent review gate** — run a **separate reviewer agent** (`/code-review`, fresh
   context — *never* the implementer) over the slice. `review:human` slices route to the
   maintainer instead. Changes requested → back to step 2.
4. **Merge** the slice into the **track branch** (agent-merged — agents never touch `main`).
5. Report progress and continue. When only the `needs-acceptance` issue remains, the track
   is ready for the back bookend.

Surface anything the reviewer agent or the verify gate can't resolve — don't merge past a
red gate.

## Workflow: acceptance gate (needs-acceptance → merge to main)

The **back bookend**, and the human's main touchpoint. When every slice has merged into the
track branch:

1. Present the integrated feature for the maintainer to **verify on the track branch**: the
   verify gate always, the in-situ harness for UI, **and a real end-to-end exercise of the
   integrated feature** — run the actual command / entry path, not just the gate. The verify
   gate is unit + lint + type; it stays **green while integrated behaviour is broken** — a
   method stubbed to throw but only ever faked in tests, an invalid CLI flag, an unwired
   module. Static review can't catch those either. Acceptance is the only place they surface,
   so the live run is mandatory, not optional. (Codified after a shipped feature passed every
   gate yet failed on first real invocation — SPEC §5.5/§7.)
2. **Accept** → the **maintainer** opens the track-branch → `main` PR and merges it (only the
   maintainer merges `main`, ADR-0001). Close the acceptance issue and the `tracking` parent.
   A slice whose PR was merged **out-of-band** (e.g. a maintainer/bot resolved a conflict and
   merged it) won't have been closed by the loop — close its issue so it isn't re-picked.
3. **Reject** → file a **corrective issue/slice on the track branch** (it never reaches
   `main` unaccepted) and keep the track open. Conflicts a stale slice hits at merge can be
   resolved on the slice branch (maintainer or an external agent) and the track resumed.

## Workflow: bugs surfaced by operating the system (self-maintenance)

Issues don't only come from reporters — **operating the delivered system is a primary input
channel, and this skill is how what's been shipped gets maintained.** A failed run, a
shipped feature that misbehaves, a defect the maintainer hits in use — each is a first-class
issue. File it *with the failure evidence* (the command, the output, a repro), then triage
it exactly like any other.

The thing being operated is often **the harness/tooling itself** — fixing it is not special:
a fix to already-shipped code is a normal `ready-for-agent` leaf (or `ready-for-human`, or a
**corrective slice on an open track** if it belongs to work in flight), and it runs the same
triage → (slice) → build → independent-review → accept loop, just entered from operation
rather than a report. Two things make these correctives land cleanly:

- **Carry the evidence into the issue** — the failing command + output + the repro — so the
  agent has a concrete repro and can name a verification method (usually a regression test).
- **A bug that only shows up live (not in the gate) needs a test that would have caught it.**
  If unit/lint/type were green while the real behaviour was broken, the fix must add the
  missing coverage (or, when it's irreducibly live, route the check to acceptance, §5.4 S4).

This is the loop maintaining its own output — including building and repairing the harness
through the harness.

## Workflow: what's ready to pick up (derived states)

The profile defines blocked / in-progress / implemented / reviewed as **derived**, not
labels. Compute them inline:

- **assignable now** = `ready-for-agent` minus any issue with an **open dependency**. Read
  refs *only* from the issue's dependency section (`Depends on:` or a `## Blocked by` list) —
  never every `#n` in the body.
- **tracks to plan-review** = `needs-plan-review`. **acceptance queue** = `needs-acceptance`
  minus blocked. **my build queue** = `ready-for-human` minus blocked.
- **my grilling queue** = `needs-grilling`. **my slicing queue** = `needs-slicing`.
  **running tracks** = `tracking`.

An issue's **assignee** is the in-progress signal — a claimed `ready-*` issue.

## Quick override

"Move #42 to X" → trust the maintainer: confirm the actions (label changes, comment, close),
apply directly, skip grilling. Flag the transition if it looks unusual per the profile's
machine.
