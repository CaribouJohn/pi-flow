---
# pi-flow profile — read by the (not-yet-built) pi-flow extension.
# Frontmatter is the machine-readable contract; prose below is what the LLM reads.
# See DESIGN.md §Config for the schema.

tracker: github
repo: CaribouJohn/pi-flow
default_branch: main
track_branch_prefix: track/

# Verify gate: the deterministic check every slice must pass before review.
# Default is a no-op that always passes; a later slice will swap this to `bun test`
# once there's something to test.
verify_gate: 'echo "verify-gate: default-pass (not yet implemented)"'

# In-situ harness: not applicable for this repo (no UI).
in_situ_harness: ""

# Reviewer-agent contract.
reviewer_command: /code-review
reviewer_iteration_cap: 2

# AFK poller cadence (seconds). Adaptive: 15s for first 5 min blocked, 60s after.
poll_cadence_seconds: 30

# AI disclaimer prefixed to every comment the extension posts on behalf of the agent.
ai_disclaimer: "🤖 Posted by pi-flow on behalf of @CaribouJohn"

# Label vocabulary — repos may rename, but role mapping is fixed.
labels:
  category:
    - bug
    - enhancement
  state:
    needs_triage: needs-triage
    needs_info: needs-info
    needs_grilling: needs-grilling
    needs_slicing: needs-slicing
    needs_plan_review: needs-plan-review
    tracking: tracking
    ready_for_agent: ready-for-agent
    ready_for_human: ready-for-human
    needs_acceptance: needs-acceptance
    wontfix: wontfix
  effort:
    low: effort:low
    medium: effort:medium
    high: effort:high
  review:
    agent: review:agent
    human: review:human
---

# Flow profile — pi-flow

This is the project profile the (not-yet-built) `pi-flow` extension will read.
Frontmatter above is the machine contract; the prose below is what the LLM
sees when running `/flow ...`.

## Tracker access

GitHub via the `gh` CLI. The authenticated user
(`gh api user --jq .login`) is the maintainer / AI-disclaimer target. All
issues and PRs live on `CaribouJohn/pi-flow`.

## Roles (state axis — exactly one per issue)

Adopt the canonical state vocabulary from
[`claude-skills/setup-flow/profile-template.md`](claude-skills/setup-flow/profile-template.md).
The headline:

- **needs-triage** — maintainer evaluates; routes to grilling, slicing, info,
  or wontfix.
- **needs-grilling** — big + solution undecided; a design grill before slicing.
- **needs-slicing** — understood + too big; decompose via `/to-issues`.
- **needs-plan-review** — freshly-sliced track awaiting the plan gate.
- **tracking** — container parent; never worked directly.
- **ready-for-agent** — fully specified; agent executes unattended.
- **ready-for-human** — a leaf only a human can do.
- **needs-acceptance** — the track's back bookend; human accept-or-reject + merge to main.
- **needs-info** — waiting on the reporter / user for clarification.
- **wontfix** — closed without action.

## Effort axis (on `ready-for-agent` leaves)

`effort:low` mechanical · `effort:medium` care needed · `effort:high` reasoning-heavy (usually: slice it further).

## Review axis (default: agent)

`review:agent` (default — reviewer sub-session gates the slice) ·
`review:human` (escalate to maintainer before merge).

## Track execution

- Track branch: `track/<name>` off `main`.
- Slice branches: off the track branch; merged back into the track branch.
- The track branch → `main` PR is opened only by the human on acceptance;
  agents never touch `main`.
- Verify gate: default no-op that always passes; swapped to a real check (likely `bun test`) by a later slice.
- Reviewer agent: `/code-review`, fresh context per slice, up to 2 rounds
  before escalating to `review:human`.

## Derived states — never hand-labelled

- **assignable** = `ready-for-agent` ∧ no open `Depends on:` issue
- **blocked-on-human** = any of `needs-acceptance`, `review:human`,
  `needs-info`, `needs-grilling`, `needs-plan-review` open in any active track
- **AFK-idle** = no `assignable` exists across any open `tracking` parent

## State machine

Per [DESIGN.md §Architecture](DESIGN.md). The machine is fixed in extension
code in v1; the v2 path lets repos extend it with extra gates.

## At-a-glance queries

```
gh issue list -l ready-for-agent
gh issue list -l needs-acceptance
gh issue list -l review:human
gh issue list -l tracking --state open
```
