# Canonical labels

The labels `setup-flow` ensures exist. **Create only if missing; never edit or delete** an
existing label. Command per row:

```
gh label create "<name>" --color <hex> --description "<description>"
```

## Category — exactly one per issue

| Name | Color | Description |
| --- | --- | --- |
| `bug` | d73a4a | Something isn't working |
| `enhancement` | a2eeef | New feature or request |

## Role / state — exactly one per issue

| Name | Color | Description |
| --- | --- | --- |
| `needs-triage` | e4a657 | Maintainer needs to evaluate this issue |
| `needs-info` | d4c5f9 | Waiting on the reporter for more information |
| `needs-grilling` | a371f7 | Big + solution undecided: a human design grill (grill-with-docs / to-prd) before slicing |
| `needs-slicing` | fbca04 | Understood + too big: decompose via /to-issues into agent-ready child issues |
| `needs-plan-review` | d876e3 | Freshly-sliced track awaiting the plan gate (reviewer agent clears or escalates) |
| `tracking` | 0052cc | Tracking parent: a container that tracks child issues; never worked directly |
| `ready-for-agent` | 0e8a16 | Fully specified to the agent floor; an agent can execute it unattended |
| `ready-for-human` | 5319e7 | A leaf a human must implement (judgment, external access, manual testing) |
| `needs-acceptance` | 1f6feb | The track's human accept-or-reject gate; verify the feature, then merge track→main |
| `wontfix` | ffffff | Will not be actioned |

## Effort axis — on `ready-for-agent` leaves

| Name | Color | Description |
| --- | --- | --- |
| `effort:low` | c2e0c6 | Mechanical — near-zero reasoning |
| `effort:medium` | fef2c0 | Specified but needs care |
| `effort:high` | f9d0c4 | Reasoning-heavy even when fully specified (usually: slice it) |

## Review axis — orthogonal policy (default: agent)

| Name | Color | Description |
| --- | --- | --- |
| `review:agent` | c5def5 | Default: an independent reviewer agent gates the slice's merge |
| `review:human` | 1d76db | Exception: escalate this slice to a human reviewer before it merges |
