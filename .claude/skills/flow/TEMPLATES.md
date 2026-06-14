# Templates

Prefix every comment or issue you post with the profile's **AI disclaimer**.

## Agent brief (for `ready-for-agent` and `ready-for-human`)

A **durable** brief — describe behaviour and contracts, not file paths or diffs (they go stale
fast). If the profile points at the repo's own agent-ready bar, follow that shape exactly;
otherwise:

- **Goal** — one sentence: what changes and why.
- **What to build** — the end-to-end behaviour. No layer-by-layer code.
- **Acceptance criteria** — checkable outcomes, observable through public interfaces.
- **Verification** — name the method (test / verify-gate / human-visual). "Looks right" with no
  method is banned.
- **Blocked by** — an explicit `Depends on: #n` for any prerequisite, so the derived *blocked*
  rule keeps working.

For `ready-for-human`, add a line on **why it can't be delegated** — judgment calls, external
access, manual testing. (`ready-for-human` is implement-only; "too big" is `needs-slicing`;
"accept the result" is `needs-acceptance`.)

`review:agent` is the **default** review policy (the profile's reviewer-agent gate). Add
`review:human` to a brief only to **escalate** a specific slice — name why (the same smells as
the plan gate: `effort:high`, an ADR-conflicting area, an irreversible migration, security).

## Acceptance issue (for `needs-acceptance`, ADR-0036)

The track's **back bookend** — one per track, filed alongside the slices when you decompose.
It is the human's accept-or-reject gate; it implements nothing.

- **Goal** — one sentence: accept the integrated `<feature>` and land the track on `main`.
- **What to verify** — the end-to-end behaviour to exercise on the **track branch** (the
  in-situ harness for UI; the verify gate always), plus any product/taste call only the
  maintainer can make.
- **On accept** — the maintainer opens the track-branch → `main` PR and merges it; close this
  issue and the `tracking` parent.
- **On reject** — file a corrective issue on the track branch (it never reaches `main`
  unaccepted).
- **Labels** — `needs-acceptance`, `review:human`. **Depends on:** every slice in the track.

## Plan-review note (for `needs-plan-review`, ADR-0036)

When the plan gate **escalates** a freshly-sliced track to the maintainer, post a short note:
what risk tripped it (an `effort:high` leaf, an ADR conflict, an irreversible migration, a
security surface), which child(ren) it concerns, and the options (re-slice, or accept-and-run).
When the gate **clears**, no note is needed — just advance the parent to `tracking` and create
the track branch.

## Triage notes (for `needs-info`)

```markdown
## Triage Notes

**What we've established so far:**
- ...

**What we still need from you:**
- ...
```

## Out-of-scope (for `wontfix` enhancements)

Write the decision into the profile's out-of-scope store (e.g. `.out-of-scope/<slug>.md`) so a
later triage finds the prior rejection, and link to it from the closing comment.
