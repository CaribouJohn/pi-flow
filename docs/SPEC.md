# Flow Harness Spec

A portable, agent-executable specification of the **Flow** delivery lifecycle —
enough to build a dedicated **AFK ("away-from-keyboard") processing app**: a harness
that drives issues from raw report to accepted-on-`main`, with humans present only at
a few bookends and an autonomous agent middle.

This document is the **machine**. It is repo-agnostic: every concrete detail (tracker,
label strings, verify command, branch names, the merge authority) is supplied by a
**profile** (§6). Hiss is the reference profile (Appendix A). It descends from the
in-conversation `/flow` skill + `docs/agents/flow-profile.md` + ADR-0022/0036/0037, but
is rewritten here as a standalone harness contract.

It is written **as the lifecycle actually runs**, not just as originally designed;
where reality diverged from the written design, §7 says so. Companion machine-readable
state table: [`transitions.yaml`](./transitions.yaml). The concrete **product design**
of an app built on this machine (dashboard, the `flowd` service, the Pi engine, model/
cost/identity policy, the skills, the Electrobun UI) lives in
[`HARNESS-DESIGN.md`](./HARNESS-DESIGN.md).

> **Design deltas (2026-06-14 grill, see HARNESS-DESIGN.md §1).** Slicing is now
> **automatic** (T12 below is an agent step, not human — the grill is the only front
> human step); the reviewer invariant strengthens to **different context *and* model**
> (§9); a **cost estimator** rides the plan gate; and autonomous actions run as a distinct
> **`flow-bot`** principal barred from `main` by **branch protection** (not token scope;
> ADR-0038).

---

## 0. The one idea that makes a harness possible

**All durable state lives in the tracker and git, never in the harness.** An item's
role is a label; its progress is *derived* from its assignee, dependencies, and linked
PRs; the code is on branches; the decisions are in comments. The harness owns almost
no state of its own.

Consequence: the harness is a **stateless reducer over (tracker + git)**. Each tick it
re-reads the world, computes derived states, picks the next legal action, performs it,
and repeats. It can crash and restart at any point and simply re-derive where it was.
Resumability is free; idempotency is the only discipline required (§8.8). Design the
harness around this and most of the hard problems (persistence, recovery, "where was
I") disappear.

---

## 1. Domain model

| Entity | What it is |
| --- | --- |
| **Item** | The unit of work (a tracker issue). Carries exactly one **role** (§2), one **category**, and orthogonal **axes** (§3). |
| **Track** | A parent Item (role `tracking`) + its child **slice** Items + exactly one **acceptance** Item. The container that runs autonomously. |
| **Slice** | A leaf child Item, agent- or human-sized, with an explicit **dependency section**. Branches off the track branch, merges into it. |
| **Profile** | The parameterization (§6) — everything repo-specific the machine refuses to hard-code. |
| **Branches** | `main` (accepted only) · one **track branch** per track off `main` · one **slice branch** per slice off the track branch. |
| **Actors** | `HUMAN` (maintainer/reporter), `ORCHESTRATOR` (the deterministic harness loop), `IMPLEMENTER` (an agent that writes a slice), `REVIEWER` (a *fresh-context* agent that gates — never the implementer), and optional judgment sub-agents (triage, plan-review). |

---

## 2. The role axis (the single load-bearing state)

Exactly one role per triaged Item. Canonical name → profile supplies the label string.
"Queue" = who must act next.

| Canonical role | Queue | Meaning |
| --- | --- | --- |
| `needs-triage` | HUMAN | Unevaluated. |
| `needs-info` | reporter | Waiting on the reporter. |
| `needs-grilling` | HUMAN | Big **and the solution is undecided** — a human design interview must produce a design artifact (PRD/ADR) first. |
| `needs-slicing` | HUMAN | Understood but too big — decompose into slices. |
| `needs-plan-review` | ORCHESTRATOR→HUMAN | A freshly-sliced track parent at the **plan gate**: validate the slice set; clear to run, or escalate. |
| `tracking` | ORCHESTRATOR | A cleared track parent. Never worked directly; closes when its children (incl. acceptance) close. |
| `ready-for-agent` | IMPLEMENTER | Fully specified to the agent floor; runs unattended. Carries an `effort:` axis. |
| `ready-for-human` | HUMAN | A leaf a human must **implement** (judgment, external access, manual/native work). |
| `needs-acceptance` | HUMAN | The single back-gate child: verify the integrated feature and merge the track to `main`. Depends on every other slice. |
| `wontfix` | — | Terminal; not actioned. |

The maintainer may force any role directly; the harness flags transitions that look
unusual per §5 and asks before proceeding (unless durably authorized).

### Front-bookend routing — grill vs slice
For a big Item the split is **"is the *solution* undecided?"**, not the category:
- solution undecided → `needs-grilling` (design first; usually enhancements);
- understood, just big → `needs-slicing` (decompose; usually bugs);
- small + clear → `ready-for-agent` / `ready-for-human` directly.

---

## 3. Orthogonal axes (policy, not state)

| Axis | Values | Role in the harness |
| --- | --- | --- |
| **category** | `bug` / `enhancement` | Signal only (informs routing); no automation depends on it. |
| **effort** | `low` / `medium` / `high` | Model-dispatch hint (match the cheapest sufficient model). `high` is a **decompose-smell** *and* a plan-gate **escalation trigger**. Track effort, not the model — model rosters churn faster than issues. |
| **review** | `agent` (default) / `human` (exception) | Who gates a slice's merge into the track branch. Absent ⇒ `agent`. `human` is escalation, same trigger logic as the plan gate. |

---

## 4. Derived states (computed every tick, never stored as labels)

| Derived state | Computation |
| --- | --- |
| **blocked** | Any Item referenced in *this* Item's **dependency section** (`Depends on: #n` / a `## Blocked by` list) is still open. Refs elsewhere in the body (parent links, prose) do **not** count. |
| **in-progress** | The Item has an **assignee** (an actor self-assigns to claim a `ready-*` Item). |
| **implemented** | A linked PR is open (into the track branch). |
| **reviewed** | The linked PR is approved (reviewer agent or human) or merged. |

The harness derives these from tracker+git on every tick; it must never hand-label
them. "Assignable now" = `ready-for-agent` AND not blocked AND not in-progress.

---

## 5. The transition table — *exactly what changes and when*

Each row: **trigger** (the event that fires it) · **actor** · **guard** (precondition) ·
**effects** (the writes — role/label, branch, PR, assignee, comment, close). Every
tracker write is prefixed with the profile's AI-disclaimer. The same table in loadable
form is [`transitions.yaml`](./transitions.yaml).

### 5.1 Triage (entry)

| # | From → To | Trigger | Actor | Guard | Effects |
| --- | --- | --- | --- | --- | --- |
| T1 | ∅ → `needs-triage` | Item created | HUMAN/system | — | role=needs-triage |
| T2 | `needs-triage` → `needs-info` | missing detail | HUMAN (orchestrator may draft) | reproduction/spec incomplete | role; post questions to reporter |
| T3 | `needs-info` → `needs-triage` | reporter responds | reporter | new info present | role |
| T4 | `needs-triage` → `wontfix` | rejected | HUMAN | — | role; write out-of-scope note; close |
| T5 | `needs-triage` → `needs-grilling` | big + solution undecided | HUMAN | — | role |
| T6 | `needs-triage` → `needs-slicing` | big + understood | HUMAN | — | role |
| T7 | `needs-triage` → `ready-for-agent` | small leaf, an agent can do it | HUMAN | meets agent-ready bar; +`effort:` | role + effort; post agent brief |
| T8 | `needs-triage` → `ready-for-human` | small leaf, needs a human | HUMAN | — | role; brief noting why human |

### 5.2 Design (human) → decomposition (automatic)

The grill is the **only front human step** (an in-app, doc-aware interview). Finishing
it lands the parent in `needs-slicing` *with a PRD*; the slicer then runs
**automatically** (T12 is an agent step, fired by the PRD — not a human action).

| # | From → To | Trigger | Actor | Guard | Effects |
| --- | --- | --- | --- | --- | --- |
| T9 | `needs-grilling` → `needs-slicing` | grill produced a PRD/ADR | HUMAN | design artifact exists | role |
| T10 | `needs-grilling` → `ready-for-agent` | grill shrank it to a leaf | HUMAN | meets agent-ready bar | role + effort |
| T11 | `needs-grilling` → `wontfix` | grill killed it | HUMAN | — | role; out-of-scope; close |
| T12 | `needs-slicing` → `needs-plan-review` | **PRD ready (auto)** | **`slice` agent** | parent has a PRD | **create child slice Items** (each: role ready-for-agent/-human, category, effort, dependency section, agent brief); **create the acceptance Item** (role needs-acceptance, review:human, Depends on every slice); set **parent** role=needs-plan-review |

### 5.3 Plan gate (front bookend — agent default, human exception)

| # | From → To | Trigger | Actor | Guard | Effects |
| --- | --- | --- | --- | --- | --- |
| T13 | `needs-plan-review` → `tracking` | plan review clears | REVIEWER (plan agent) | every child meets the agent-ready bar AND no escalation smell | parent role=tracking; **create the track branch** off `main`; **compute + post the cost estimate (= the track budget)**; post a clearance note. *(Optional "show me the plan first" toggle parks for one-time human approval before the build.)* |
| T14 | `needs-plan-review` → `needs-plan-review` (escalate) | smell detected | REVIEWER → HUMAN | `effort:high` leaf, ADR conflict, irreversible migration, or security surface | leave role; **notify HUMAN** with the named risk; await human |
| T15 | `needs-plan-review` → `needs-slicing` | human re-slices | HUMAN | — | role |

### 5.4 Autonomous middle — the per-slice loop (runs without a human)

Loop while the track has an **assignable** slice (ready-for-agent, not blocked, not
in-progress):

| # | Step | Trigger | Actor | Guard | Effects |
| --- | --- | --- | --- | --- | --- |
| S0 | (re)enter track | track is `tracking` | ORCHESTRATOR | track branch exists | **drift-refresh**: merge `main` into the track branch (merge, not rebase) |
| S1 | select + claim | assignable slice exists | ORCHESTRATOR | not blocked, not in-progress | set **assignee** (→ derived in-progress) |
| S2 | implement | claimed | IMPLEMENTER | self-contained brief | create **slice branch** off track branch; write code; **per-slice doc duty** (update user docs / add TSDoc for user-visible change) |
| S3 | verify gate | code ready | IMPLEMENTER | — | run the profile's verify command; must be **green** (else iterate, bounded; §8.7) |
| S4 | in-situ verify | UI/device-bound slice | IMPLEMENTER | profile has an in-situ harness | drive the real app; capture evidence. **If not automatable, do NOT fake it — defer that check to acceptance (§9)** |
| S5 | open PR | gate green | IMPLEMENTER | base = **track branch** | open slice PR → derived *implemented* |
| S6 | review gate | PR open | REVIEWER (fresh context, ≠ IMPLEMENTER) | review:agent | adversarial review → **APPROVE** or **REQUEST CHANGES**; post verdict comment |
| S6a | changes requested | verdict | ORCHESTRATOR | REQUEST CHANGES | back to S2 with the review |
| S6h | human review | PR open | HUMAN | review:human | route to human reviewer instead of S6 |
| S7 | merge | approved | ORCHESTRATOR | green gate + APPROVE | **merge slice PR into the track branch** (agent-merged); delete slice branch; **close the slice Item** |
| S8 | repeat | — | ORCHESTRATOR | more assignable slices | loop to S1; closing S7 may unblock dependents |

When no assignable slice remains and only the acceptance Item is open → §5.5.

### 5.5 Acceptance (back bookend — human-owned) + the inviolable merge boundary

| # | From → To | Trigger | Actor | Guard | Effects |
| --- | --- | --- | --- | --- | --- |
| A1 | track ready | all non-acceptance slices closed | ORCHESTRATOR | — | **notify HUMAN**; post acceptance summary + the **in-situ checklist** (the checks S4 deferred); open or stage the **track→main PR** (`Closes` the parent + acceptance Items) — but **do not merge it** |
| A2 | accept | HUMAN verifies on the track branch | HUMAN | maintainer satisfied | **HUMAN merges the track→main PR** (only the maintainer merges `main`); parent + acceptance Items auto-close |
| A3 | reject | a defect found at acceptance | HUMAN→ORCHESTRATOR | — | spawn **corrective slice(s) on the track branch** (S1–S7); never let it reach `main` unaccepted; re-present (A1) |

**Boundary (do not cross): the harness never merges `main`.** It opens/stages the
track→main PR and parks for the human — even when the human says "just merge it." See
§7 (observed) and §9 (invariant).

---

## 6. The profile (what a harness needs to run any repo)

The machine above is constant. A **profile** supplies:

1. **Tracker adapter** — list/get items by label; read/parse the dependency section;
   create item; set label/role; set assignee; comment; close. (e.g. GitHub Issues via
   `gh`.)
2. **Label map** — canonical role → label string; the `category`/`effort`/`review`
   label strings.
3. **AI-disclaimer prefix** — prepended to every harness-authored comment/body.
4. **Verify gate command** — the deterministic must-pass build/lint/test command.
5. **Branch model** — `main` name; track-branch naming (`track/<slug>`); slice-branch
   naming; merge policy (squash/merge); the drift-refresh policy.
6. **Review policy + reviewer invocation** — how to spawn the fresh-context reviewer
   (the code-review agent) and parse its verdict.
7. **In-situ verification harness** *(optional)* — how to drive the real app for UI
   slices (e.g. CDP), and what counts as evidence.
8. **Agent-ready bar** — the contract a slice must meet to be `ready-for-agent`
   (exact files, no open design calls, a named verification method).
9. **Out-of-scope store** — where `wontfix` rationale is written.
10. **Merge authority** — *who* merges `main` (always a human; the harness records it
    and never assumes it).
11. **Notification channel** — how the AFK app pings the human, and the payload shape.

Keep the machine free of all of the above. (This mirrors the skill/profile split the
lifecycle already uses, and is why it ports.)

---

## 7. As-actually-run: reconciliation with the written design

What real execution (incl. the Hiss voice-audio track) showed, vs the design — codify
these in the harness:

- **Tracks are entered mid-lifecycle.** A track was already `tracking` (plan gate
  pre-cleared in an earlier run). The harness must **resume from the current world**
  (§0), not assume it starts at triage. Every state is an entry point.
- **Drift-refresh is a real step, not a footnote (S0).** The track branch was stale
  (behind `main`); the first action on (re)entering a track was `git merge main` into
  it. Make this an explicit step, not advice.
- **In-progress claim was implicit.** Running single-threaded, slices weren't always
  explicitly self-assigned; "in-progress" was effectively tracked by the orchestrator's
  own loop. **A concurrent harness MUST set the assignee** (S1) or it will double-pick.
  Treat the claim as mandatory; it is also the only cross-process lock.
- **The reviewer gate works as a fresh-context sub-agent with a self-contained,
  adversarial brief** that returns a structured **APPROVE / REQUEST CHANGES** verdict,
  posted to the tracker; merge only on APPROVE. Independence (reviewer ≠ implementer)
  is the safety property — enforce it structurally, not by convention.
- **Some verification is irreducibly in-situ** (device-bound audio, real permission
  prompts, WebView behavior). The implementer **could not and must not fake it**; those
  checks were explicitly deferred to the acceptance bookend with a written checklist
  (S4→A1). The harness must distinguish *unit-verifiable* from *in-situ-only* and route
  the latter forward honestly — never report unverified behavior as working.
- **Per-slice doc duty is enforced at the slice PR** (S2/S6), so user docs publish
  atomically with the feature at acceptance and can never describe unshipped behavior.
- **Acceptance is an interactive loop, not a single gate.** In practice the human
  reported defects live and corrective fixes were made as **direct fix-branches → review
  → merge into the track branch** (A3), rather than always filing formal "corrective
  issues." The harness should support a tight **acceptance feedback loop**: human report
  → corrective slice on the track branch → re-gate → re-present — and keep it off `main`.
- **The main-merge boundary held even under explicit "merge it" delegation.** When the
  maintainer said "merge things," the harness still **opened the PR and parked the
  `main` merge for the human** (A1/A2). This is the one place where a casual instruction
  does not override the codified boundary; the harness asks for the merge rather than
  performing it. (See §9.)
- **Closing semantics:** slice Items close on merge-into-track (S7); the parent +
  acceptance Items close on the track→main merge, via `Closes #n` keywords in the PR
  body (A1/A2). Deferred/native follow-ups stay open and are linked.

---

## 8. The harness (AFK app) architecture

### 8.1 Shape
A stateless **orchestrator** over (tracker + git) (§0). Deterministic control flow;
delegates only *judgment* to agents. No hidden internal state machine — the tracker is
the state machine.

### 8.2 The tick (one pass)
```
loop:
  world      = read(tracker active items) + read(git branches, PRs, statuses)
  derived    = compute(blocked, in-progress, implemented, reviewed)   # §4
  queues     = classify(world, derived)                               # §8.5
  if queues.agent_runnable not empty:
      advance_one_step(pick(queues.agent_runnable))                   # §5.4 / §5.3
      continue                                                        # re-read; idempotent
  else:
      for h in queues.human:  ensure_handoff_artifact(h); notify(h)   # §8.5
      await(human action OR external event OR backoff timer)          # then loop
```
Drive to a **fixpoint**: keep advancing agent-runnable work until only human bookends
remain, then produce hand-offs, notify, and sleep/await.

### 8.3 Concurrency
Slices in one track with no cross-dependency may run in **parallel** — each in its own
git worktree off the track branch to avoid working-tree conflicts. The **assignee
claim (S1) is the lock** that prevents two workers grabbing the same slice. Bound
concurrency (CPU / rate limits). Serialize the merge step (S7) per track branch.

### 8.4 The agents
| Agent | Context | Job | Output |
| --- | --- | --- | --- |
| ORCHESTRATOR | persistent, deterministic | the loop; all tracker/git writes; gate enforcement | actions |
| IMPLEMENTER | per slice, self-contained brief | write the slice, green the verify gate, in-situ verify if possible, open PR, doc duty | branch + PR |
| REVIEWER | **fresh** per slice, ≠ implementer | adversarially review the slice PR | APPROVE / REQUEST CHANGES + findings |
| PLAN-REVIEWER | fresh, per track | validate slice set vs the agent-ready bar; judge risk | clear / escalate |
| (TRIAGE) | optional | recommend role/category | a recommendation a human confirms |

The orchestrator must **guarantee reviewer ≠ implementer** (don't reuse a context).

### 8.5 Human bookends & touchpoints
States that **await a human**: `needs-triage`, `needs-info`, `needs-grilling`,
`needs-slicing`, plan-gate **escalation** (T14), `ready-for-human`, `review:human`
slices, and `needs-acceptance`. For each, the harness's job is to **produce the best
hand-off artifact and notify** — never to fake the human step:
- triage → a recommendation; grilling → surface + hand to the design interview;
  slicing → a decomposition proposal; escalation → the named risk; ready-for-human → an
  implement-only brief; acceptance → integrated summary + the in-situ checklist + the
  staged (unmerged) track→main PR.
Then **park** and resume when the human's action shows up as a tracker state change.

### 8.6 Gates (never merge past a red one)
1. **Verify gate** — deterministic; the profile's command must exit green (S3).
2. **Reviewer gate** — judgment; APPROVE required (S6).
3. **In-situ** — for checks that need the real app; if not automatable, routed to
   acceptance (S4→A1), not skipped silently.

### 8.7 Failure handling
- verify gate red → IMPLEMENTER iterates, **bounded** (e.g. N attempts); then park to
  human with the failure.
- REQUEST CHANGES → back to S2 with the review attached.
- merge conflict / drift → drift-refresh (S0) and rebuild; if unresolved, park.
- flaky / ambiguous / repeated failure → **escalate to human, don't loop**.
- in-situ not verifiable → defer to acceptance with an explicit checklist (don't claim
  success).

### 8.8 Resumption & idempotency
Because state is externalized (§0), restart = re-read + re-derive. Make every action
**idempotent or guarded**: check before label/assign/comment; don't open a PR that
exists; don't re-run a passed gate; key one-shot side-effects (like a permission probe)
behind a flag. A duplicate tick must be a no-op.

### 8.9 Capability surface (the integration contract)
The harness needs: **tracker** CRUD + dependency parsing + issue creation; **git/forge**
branch/commit/push/PR(open, base=track|main)/merge(**track only**)/delete/read-status;
**shell** to run the verify command and arbitrary build/test; **agent-spawn** with a
self-contained prompt, a structured-output (verdict) schema, and a reviewer≠implementer
guarantee; an optional **in-situ driver** (e.g. CDP); a **notification** channel; and a
**clock/scheduler** for ticks, backoff, and await-human.

---

## 9. Invariants (the harness must never violate these)

1. **The harness never merges `main`.** It opens/stages the track→main PR and parks for
   the human — even under "just merge it." (Casual delegation does not override the
   codified boundary; re-confirmation specifically about `main` is required, and a
   conservative harness still defers.) Enforced **structurally by branch protection on
   `main`** (excluding the `flow-bot` principal), *not* by token scope — tokens are
   repo-scoped, not branch-scoped; "no main-merge code" is defence-in-depth only
   (ADR-0038).
2. **Reviewer ≠ implementer — different context *and* different model.** Independence
   is the correctness property; a different model gives genuinely independent blind
   spots, not just a fresh context. Enforce both structurally.
3. **Never merge past a red gate** (verify or reviewer).
4. **Never report unverified behavior as working.** In-situ-only checks route to
   acceptance with a checklist.
5. **Decisions are labels; volatile states are derived.** Never hand-label
   blocked/in-progress/implemented/reviewed.
6. **Slices merge into the track branch, never `main`.** `main` stays accepted-only.
7. **Respect dependencies** — never pick an out-of-order leaf (§4).
8. **Every tracker write carries the AI-disclaimer prefix.**
9. **Claim before work** (set assignee) — the only cross-worker lock.

---

## 10. What stays human (the irreducible)

Triage sign-off · the design grill (an interview) · decomposition/slicing · the
plan-gate escalation call (agent default, human on smell) · `ready-for-human`
implementation · `review:human` slices · acceptance taste + device-bound in-situ
verification · **the `main` merge**. The AFK app's value is doing *everything else*
and handing these off cleanly — not pretending to do them.

---

## Appendix A — Reference profile (Hiss)

| Profile slot | Hiss value |
| --- | --- |
| Tracker | GitHub Issues via `gh` (`github.com/CaribouJohn/hiss`) |
| Label map | canonical role == label string (`needs-triage`, `tracking`, `ready-for-agent`, …); axes `bug`/`enhancement`, `effort:low|medium|high`, `review:agent|human` |
| AI disclaimer | `> *This was generated by AI during triage.*` |
| Verify gate | `bun run lint && bun run typecheck && bun test && (cd packages/hiss-desktop && bunx vite build)` |
| Branch model | `main`; track `track/<slug>`; slice `slice/<n>-<slug>`; squash-merge; merge `main`→track to de-drift |
| Reviewer | a fresh-context `/code-review`-style sub-agent; verdict posted as an issue/PR comment |
| In-situ harness | `electrobun-dev` (drives the real WebView2 app over CDP) |
| Agent-ready bar | `docs/agents/agent-ready-issues.md` |
| Out-of-scope store | `.out-of-scope/*.md` |
| Merge authority | the maintainer (ADR-0001), never an agent |
| Source docs | `/flow` skill · `docs/agents/flow-profile.md` · ADR-0022 / ADR-0036 / ADR-0037 |
