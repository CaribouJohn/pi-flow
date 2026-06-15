# Agent-ready issues

How to write an issue that a **low-reasoning coding agent** (e.g. a small/cheap model
routed by effort) can complete unsupervised, with a reviewer agent gating the resulting PR.

This is the bar the `ready-for-agent` label promises. An issue carrying that label
**is a contract**: the agent should need nothing that isn't in the body.

## The capability floor we design for

Assume the executor (pi-flow's implementer is a `pi-coding-agent` with read/grep/find
tools — it **can** explore):

- **Strongly prefers named files and regions.** Name exact files, symbols, and regions
  whenever you know them — it keeps the blast radius small and lets the plan-reviewer
  validate scope. But the agent *can* explore the repo if it must; this is a discipline
  for the author, not a tool limitation.
- **No open design calls** — no "choose an approach," no open trade-offs. The decision
  is already made, in the issue. *(Absolute.)*
- **Must name a verification method** — "looks right" with no method is banned. Done
  must be provable (see [Verification](#verification)). *(Absolute.)*
- **Small blast radius** — one concern, few files, so a wrong turn is cheap and the PR
  reviews at a glance.

Anything that can't be reduced to this floor is either **`needs-slicing`** (too big or
fuzzy — decompose it into leaves under a `tracking` parent), or **`ready-for-human`**
(a single leaf that nonetheless needs a human to *implement* it — judgment calls,
external access, manual testing). Those two are distinct: `ready-for-human` is
implement-only, never "too big". See the [flow profile](../../.pi/flow.profile.md).

## The `effort:` axis

`ready-for-agent` answers *"is it spelled out enough?"*. It does **not** answer
*"how much reasoning does executing it take?"* — those are orthogonal. A fully
specified rename and a fully specified fiddly algorithm are both ready, but only
one is safe for the weakest model. Capture that second axis with a single label:

| Label | Meaning |
| --- | --- |
| `effort:low` | Mechanical. Near-zero reasoning — rename, move, add a guard, copy an existing pattern. |
| `effort:medium` | Specified but needs care — a new component following an existing one, multi-file wiring. |
| `effort:high` | Reasoning-heavy **even when fully specified**. |

**`effort:high` + `ready-for-agent` is a smell** — it usually means the issue isn't
decomposed enough. Mark it `needs-slicing` and split it until the leaves are low/medium;
fall back to `ready-for-human` only when a leaf genuinely needs a human to implement.
`effort:high` is also a **plan-gate escalation trigger**: if a freshly-sliced track
contains an `effort:high` leaf, the plan-review agent escalates it to the maintainer
before the track can run.

### Why effort, not the model

We deliberately do **not** label the target model (`requires:sonnet-4.6` etc.):

- The roster churns far faster than the issues — any model label is stale by the
  next release and forces a re-label sweep.
- Which model to use is a **dispatch-time** decision (cost, availability, who's
  free), read off the body in the moment — not a property baked into the ticket.
- `effort:` maps directly onto the reasoning/effort knob every harness already
  exposes, so the dispatcher reads `ready-for-agent` + `effort:low` and confidently
  hands it to the cheapest model on max effort.

## Granularity

- **Vertical slice by default** — one issue = one slice = one PR that's
  independently valuable and reviews at a glance. This is the same unit the slice
  agent produces; agent-ready issues are just slices spelled out to the floor.
- **Ordered child issues for hard splits** — when a slice is still `effort:high`,
  label it `needs-slicing` and break it into child issues under a `tracking` parent
  (the parent becomes the container). Prefer independently-mergeable children. If you
  must go horizontal (type → impl → wiring), each child carries an explicit
  **`Depends on: #<n>`** so the agent never picks up an out-of-order leaf.
- Decompose until leaves are `effort:low`/`medium`. A leaf that still can't be agent-run
  is `ready-for-human` (implement-only); a node that's still too big stays `needs-slicing`.

## Verification

Every agent-ready issue must **name its verification method**. "Looks right" with no
method is banned — that ambiguity is what sinks a weak model.

### Active methods (headless set)

These are the methods the autonomous middle can self-confirm today:

| Method | When | What the issue ships |
| --- | --- | --- |
| `test-verifiable` *(preferred)* | Logic, parsing, state, core behaviour | The exact failing test to make pass (RED→GREEN). Agent self-confirms with `bun test`. |
| `verify-gate-only` | Pure refactor / rename / move | The change is proven by the verify gate alone (lint + typecheck + test). |

Always, regardless of method, the verify gate must pass:

```
bun run verify
```

(`bun run lint && bun run typecheck && bun run test`)

### Reserved / forward-looking

| Method | Status | Meaning |
| --- | --- | --- |
| `human-visual` / in-situ | **Reserved.** Not active — routes to acceptance. | CSS, layout, device-bound behaviour — anything that needs the real app to judge. An in-situ harness (`in_situ_harness` in the flow profile) is empty today; when a future dashboard track supplies one, this method activates for UI-bearing slices. Until then, any slice needing this check is deferred to the acceptance bookend (SPEC S4→A1): the implementer runs the verify gate, notes what couldn't be self-confirmed, and the maintainer checks it live at acceptance. Do **not** mark a slice `ready-for-agent` if it depends on in-situ verification and the harness isn't active — route it to `ready-for-human`. |

Beyond the issue's own method, every slice also passes an **independent reviewer-agent
gate** before it merges into the track branch: a fresh-context reviewer agent
(`/code-review`), a *different model* from the implementer, is what catches the
dropped-safeguard / premature-abstraction class the verify gate can't. `review:agent`
(that gate) is the **default**; `review:human` escalates a single risky slice to a
human. See the [flow profile](../../.pi/flow.profile.md) ("Track execution").

## The template

```markdown
## Goal
<one sentence: what changes and why — the high-level review anchor>

## Files to touch
- path/to/file.ts — <what, which symbol/region>
- (name exact files when you know them — the agent can explore if needed, but exact
  paths keep the blast radius small and let the plan-reviewer validate scope)

## The change
<the already-decided steps. Concrete. No "choose an approach" / no open trade-offs.>
1. ...
2. ...

## Verification
Method: test-verifiable | verify-gate-only
- <exact failing test to make pass (for test-verifiable), OR "proven by the verify gate"
  (for verify-gate-only)>
- Always: `bun run verify`

## Out of scope / don't touch
- <explicit guardrails — the floor won't infer boundaries>

## Meta
- Labels: `ready-for-agent`, `effort:low|medium|high`
- Depends on: #<n>   (omit if none)
```

The litmus test: **the issue is the contract.** If the agent would need to ask a
question or make a judgment call, the issue isn't ready — fill that gap or drop to
`ready-for-human`. (The agent *can* explore the repo — discovery is not why we drop
to human; only **open design calls** and **missing verification method** are.)

## Relationship to the workflow

This is the bar the `slice` agent writes to and the `plan-review` agent validates
against (SPEC §5.2–5.3). Before the autonomous track runs, every child slice is checked
against this contract — a child that fails the bar triggers a plan-gate escalation.
