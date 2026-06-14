# flow

A **portable** delivery-lifecycle skill. It drives a label-based state machine —
triage, decompose, a plan-review gate, autonomous build/review/merge of a feature
track, and a human acceptance gate — but the machine itself lives in a **repo-local
project profile** (in this repo, `.pi/flow.profile.md`), not in the skill. The
skill carries only the *behaviour*; the profile carries the *specifics* — tracker
access, the role↔label mapping, the axes, the derived-state rules, the track-execution
model (branch/merge/reviewer-agent), and the state diagram. That split is what makes it
drop-in for any repo and safe to publish: the skill body holds **zero** project
vocabulary.

> Operational instructions are in [`SKILL.md`](SKILL.md); brief/notes/acceptance shapes
> in [`TEMPLATES.md`](TEMPLATES.md). This README is the rationale + a usage walkthrough.

## Lineage

`flow` began as `triage-process`: a triage state machine lifted out of the stock Matt
Pocock `triage` / `github-triage` skills (a five-role machine baked into user-global,
re-installable skills) and into a repo-local profile a generic skill reads — then
extended with the states the real workload demanded. **ADR-0022** records that first
step (the `needs-slicing` / `tracking` split, the `effort:` and `review:` axes, and the
rule that volatile/derivable state — blocked / in-progress / implemented / reviewed — is
*computed, never hand-labelled*).

**ADR-0036** is the second step, and the reason it's now called `flow`: once an agent
can both *verify a change in situ* (drive the real app via the `electrobun-dev` skill)
and *supply an independent review pass* (a fresh-context reviewer agent), the human no
longer needs to be in the loop on every PR. The skill grew from "triage the issues" into
"**drive the whole lifecycle**", with the human at two bookends and an autonomous middle.

**ADR-0037** refines the front bookend: a `needs-grilling` state for "big and the
*solution* is undecided" — a human design grill (`/grill-with-docs` or `/grill-me` →
`/to-prd`/ADR) that's a precondition for good slicing. `/flow` surfaces it and hands off
to the specific skill, but never runs the grill itself.

## What ADR-0036 changed

- **Human-in-the-loop collapses to two bookends per feature track** — a (usually
  agent-routed) **plan gate** at the front and a **human acceptance gate** at the back.
  The middle — implement → review → merge — runs unattended.
- **An independent reviewer agent gates each slice merge** — never the implementer
  (shared blind spots). This preserves the *independence* ADR-0001 was actually buying
  while swapping the reviewer from human to a fresh-context agent.
- **A feature-track branch; agents never touch `main`.** Slices merge into the track
  branch (reviewer-agent-gated, agent-merged); only the track branch PRs off `main`,
  maintainer-merged after acceptance. `main` stays accepted-features-only, and ADR-0001's
  "the maintainer merges `main`" stays literally true.
- **Two new roles + a `review:` default-flip** — `needs-plan-review` (parent front gate)
  and `needs-acceptance` (back-gate child); `review:agent` becomes the default,
  `review:human` the per-slice escalation.

## The states at a glance

Hand-set role (one per issue): `needs-triage` · `needs-info` · **`needs-grilling`** ·
`needs-slicing` · **`needs-plan-review`** · `tracking` · `ready-for-agent` ·
`ready-for-human` · **`needs-acceptance`** · `wontfix`. Orthogonal axes: `effort:low|medium|high` (on
agent-ready leaves) and `review:agent|human` (policy; **default agent**, human is the
escalation exception). Derived, never hand-labelled: **blocked** (`Depends on:`),
**in-progress** (assignee), **implemented / reviewed** (linked PR). The full diagram +
the track-execution model live in the repo's profile.

## Using it — example flows

Invoked as `/flow` followed by natural language; it reads the profile first, then
interprets the request.

### 1. Morning scan — what needs my attention?

```
You:  /flow what needs attention?
Flow: Needs triage — 3 · needs-plan-review (escalated) — 1 (#268: an effort:high leaf
      tripped the plan gate) · needs-acceptance ready — 1 (#394: all slices merged).
      Which would you like?
```

### 2. Decompose — `needs-slicing` → `needs-plan-review`

```
You:  /flow #268 is too big to assign
Flow: That's needs-slicing. I'll label it, run /to-issues for the slices, then file the
      acceptance issue (needs-acceptance, depends on all slices).
      Children filed (#270–#275) + acceptance #276. Per the machine, #268 enters
      needs-plan-review — it must pass the plan gate before it runs.
```

### 3. Plan gate — clear or escalate

```
You:  /flow run the plan gate on #268
Flow: [reviewer agent validates each child against the agent-ready bar]
      #270–#274 clear the bar. #275 is effort:high and touches an ADR — escalating.
      #268 stays in needs-plan-review; here's the risk + your options (re-slice / run).
```

### 4. Work the track — the autonomous middle

```
You:  /flow work the agent-ready tasks on #268
Flow: Track branch track/server-auth is up. Assignable now: #270.
      [implements #270 off the track branch → verify gate green → /code-review gates it
       → merges into track branch] → next: #271 …
      Stopping at #276 (needs-acceptance) — that's your gate.
```

### 5. Acceptance — the back bookend

```
You:  /flow accept the #268 track
Flow: All slices merged into track/server-auth. Verified the feature on the branch
      (gate green; in-situ checks pass). Accept → I'll open track→main for you to merge.
```

### 6. Quick override — trust the maintainer

```
You:  /flow move #42 to ready-for-human
Flow: Applying ready-for-human (clearing needs-triage). Looks fine for the machine —
      confirming: label change + a short note. Done.
```

If a requested transition looks unusual for the profile's machine, the skill flags it
and asks before proceeding.

## Adopting it in another repo

1. Copy this skill directory in (no edits to its body needed).
2. Run `/setup-flow` (the companion skill) — or by hand: add a **flow profile** at
   `.pi/flow.profile.md` describing *your* tracker access, role↔label mapping,
   axes, derived-state rules, track-execution model, and state diagram, and create the
   canonical labels.
3. (Optional) record the rationale for any deviations in an ADR.

The skill reads the profile and adapts — the same skill drops into any repo by swapping
the profile, never the skill.
