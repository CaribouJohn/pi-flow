# PRD-0003 — Front bookend (headless): auto-slice + agent plan-gate + cost estimate

**Status:** ready to slice (grilled 2026-06-15, `/grill-with-docs`)
**Tracker:** [#104](https://github.com/CaribouJohn/pi-flow/issues/104) (`needs-grilling` → this PRD lands it in `needs-slicing`)
**Parent design:** [SPEC.md](../SPEC.md) §5.2–5.3, §8.4 · [HARNESS-DESIGN.md](../HARNESS-DESIGN.md) §3–§4, §8.1
**Builds on:** PRD-0001 (the headless build loop `flowd run`); reuses `packages/flow-engine` + `packages/flowd-cli`.

---

## 1. Why this next

PRD-0001 shipped the **autonomous middle** — `flowd run --track <n>` driving one slice S0–S8
to a fixpoint against the sandbox. The riskiest novel thing (`pi-coding-agent` driving
implement + different-model review + agent-merge) is proven.

This track builds the **front bookend's headless half** — everything *upstream* of that
loop: turning a PRD into a cleared, runnable track. It is the natural extension of the
engine and keeps to the roadmap's sequencing principle — **de-risk the engine before the
pixels**. It adds two new LLM role agents (`slice`, `plan-review`) and one deterministic
`flowd` capability (the cost estimator), following the exact patterns 0001 established.

## 2. Scope boundary (decided in the grill)

**Headless engine only.** The interactive, doc-aware **grill *chat*** (T9 — an in-app
interview that *produces* the PRD) is **out of scope**: it is UI-bound and needs the
dashboard webview (PRD-0002+). For this track the PRD is authored as it is today — by the
maintainer via the existing `/grill-with-docs` skill — and lives as a markdown file on
disk. flowd consumes that file. This keeps 0003 a pure CLI track like 0001, dogfoodable
immediately.

## 3. The one outcome (definition of done)

A single command —

```
flowd plan --issue <n> --prd docs/prd/NNNN-*.md
```

— against the **sandbox repo**, where issue `<n>` is a parent in `needs-slicing` with a PRD
on disk, drives the front bookend to a fixpoint. Concretely, after one invocation:

1. a **`slice` agent** (T12) read the PRD + repo docs (CONTEXT.md, ADRs, the agent-ready
   bar) and emitted a **schema-validated slice plan** via a `submit_slice_plan` tool;
2. the **orchestrator** created the child slice Items (each with role
   `ready-for-agent`/`-human`, `category`, `effort`, `review`, a dependency section, and an
   agent brief) **and** the single `needs-acceptance` Item (`review:human`, `Depends on:`
   every slice), then set the **parent → `needs-plan-review`**;
3. a **`plan-review` agent** (T13/T14) — a *different model* than the slicer — validated
   each child against the agent-ready bar and judged the semantic escalation smells,
   returning a `submit_plan_review` verdict (clear | escalate + named risks + per-child
   agent-ready pass/fail);
4. the orchestrator combined that verdict with its **deterministic `effort:high` check**:
   - **clear** → parent → `tracking`; **create the track branch** off `main`; **compute +
     post the cost estimate** (= the budget) and a clearance note as marker comments;
   - **escalate** (T14) → leave parent in `needs-plan-review`; post the **named risk(s)**;
     stop (await human).

Re-running the command is a **no-op** at every reached state (idempotent; SPEC §8.8 — see
§7). The produced `tracking` track is then runnable by 0001's `flowd run --track <n>`
unchanged — the two compose; they are **not** unified here (the daemon, PRD-0005, wraps
both).

## 4. Architecture & key decisions

All decisions below were settled in the grill.

### 4.1 Entry & PRD source (Q1)
`flowd plan --issue <n> --prd <path>`. The **PRD file on disk is the source of truth**; the
issue is the anchor. One command drives T12 → T13/T14 to a fixpoint.

### 4.2 Slice agent — agent plans, flowd writes (Q2)
The `slice` Pi session (`pi-coding-agent`, read-only doc tools) reads the PRD + repo docs
and emits the decomposition through a `submit_slice_plan` custom tool — **it never writes
to the tracker itself**. Deterministic `flowd` validates the plan and performs every issue
write. Mirrors 0001's `submit_verdict`; keeps all tracker writes in the orchestrator
(SPEC §8.4); the plan is schema-validated and the writing logic is unit-testable over
fakes.

The plan shape (per slice): `title`, `brief`, `effort` (low|medium|high),
`category` (bug|enhancement), `review` (agent|human), `dependsOn` (indices into the plan,
**not** issue numbers). Plus the single acceptance Item (implicitly `Depends on:` every
slice). The orchestrator resolves `dependsOn` **indices → real issue numbers** after the
children are created, then writes each child's `## Blocked by` section (the form the
derive step reads). The agent's prompt carries guidance for when to mark `review:human`
(judgment calls, external access, manual/native work) and `ready-for-human` vs
`ready-for-agent`.

### 4.3 Plan-review agent — independent, different model (Q3)
`plan-review` is a **separate fresh Pi session on a *different model* than the slicer** —
the same independence rule as S6 (reviewer ≠ implementer), extended to the plan gate so the
slicer can't grade its own homework with shared blind spots. It reads the created child
Items + PRD and emits `submit_plan_review`: `decision` (CLEAR | ESCALATE), `risks`
(named), and per-child `agentReady` pass/fail with reasons. (This strengthens SPEC §9
invariant #2's spirit to the plan gate — captured as a SPEC delta, §10.)

### 4.4 Escalation smells — hybrid detection (Q4)
- **Deterministic (flowd):** an `effort:high` leaf — a label, certain, never left
  probabilistic.
- **Agent (plan-review):** the three semantic smells — **ADR conflict**, **irreversible
  migration**, **security surface** — returned as named risks.
- flowd **escalates (T14) if *either* source flags**; otherwise clears (T13).

### 4.5 Cost estimate — deterministic flowd capability (Q5)
Not an agent skill (HARNESS-DESIGN §8.1). The pre-flight estimate is
`Σ slices ( implement + review )`, where each role's **expected tokens** come from a static
`effort→tokens` table and **price** from a `model price` table (both in flowd config), via
the `effort→model` routing. A fixed **rework multiplier** (≈ ×1.3, reflecting
`reviewer_iteration_cap`) covers REQUEST_CHANGES iterations. Posted at the gate as
`≈ $X.XX, N slices`. The static tables are admittedly rough v1 guesses; **calibration from
measured actuals is PRD-0004's meter** — this track ships only the estimate (which *is* the
budget at T13).

### 4.6 Idempotency — re-derive + per-child dedup (Q6)
Two layers (SPEC §0/§8.8):
1. **Parent-role gate** — if the parent is already past `needs-slicing`
   (`needs-plan-review`/`tracking`), skip T12 entirely (re-derive from the tracker).
2. **Per-child existence check** — each child carries a stable marker (a `Parent: #n` line
   + a deterministic title); before creating one, query for an existing open child under
   this parent with that identity and skip if present. A crash mid-slice (3 of 5 created)
   resumes cleanly with no duplicates.

Plan-gate side guards as in 0001: track branch existence check before create; the cost
estimate + clearance + escalation are **marker comments** so re-runs don't duplicate.

### 4.7 Composition (Q7)
`flowd plan` and `flowd run` are **separate one-shot commands**, chained by the operator or
a script. Unified state-machine dispatch across all phases is PRD-0005's daemon job
(SPEC §8.2). The optional T13 "show me the plan first" human checkpoint is deferred to a
later flag (e.g. `--park-for-approval`) — out of scope v1.

## 5. Model routing & config

Extend the role→model config (0001's `model-config.ts`) with two new roles: `slice` and
`planReview`, both routed to a "strong" model (HARNESS-DESIGN §4). Reuse and extend
`validateRoleModelConfig` to **reject `planReview === slice`** (the §4.3 independence rule),
exactly as 0001 rejects `review === implement`. Reuse the ported credential store and
env-scrub from 0001 unchanged.

## 6. The agent-ready bar (a prerequisite — Q9)

pi-flow has **no concrete agent-ready bar doc today** (profile slot 8 unfilled; only
SPEC §6's inline one-liner). Both new agents depend on it (slice *writes* to it,
plan-review *validates* against it), and it's referenced by T7/T10 triage too. So a small
**prerequisite slice** authors `docs/agents/agent-ready-issues.md` — the criteria (exact
files, no open design calls, a named verification method) + the slice-contract fields — and
**wires the profile's slot 8** to it. It is a HITL design artifact (the maintainer owns
what "agent-ready" means); both agents then cite it.

## 7. Invariants this PRD must honour (SPEC §9)

- **Orchestrator owns all tracker writes** — agents only emit structured judgment
  (`submit_slice_plan`, `submit_plan_review`); flowd performs every create/label/comment
  (§8.4).
- **Plan-reviewer ≠ slicer, different context *and* model** — enforced structurally
  (distinct sessions + a config guard refusing equal models). §4.3.
- **Never clear past an unclear gate** — a plan-review that returns no verdict, or any
  flagged smell (agent *or* deterministic), escalates; never a silent clear (the same
  fail-safe stance as 0001's reviewer).
- **Slices/branches off the track branch, never `main`** — T13 creates `track/<slug>` off
  `main`; no main-merge code path.
- **Respect dependencies** — children's `## Blocked by` sections are written from the
  resolved plan so the derive step computes `blocked` correctly.
- **Every tracker write carries the AI-disclaimer prefix** (profile value).

## 8. Non-goals (deferred to later PRDs)

- **The grill *chat*** (T9, interactive/UI) — needs the dashboard (PRD-0002+).
- **Cost *meter*** (actual vs estimate) + estimate calibration — PRD-0004.
- **`flow-bot` identity / branch protection / keychain** — PRD-0004 (this track keeps
  0001's ordinary `gh`/PAT auth + defence-in-depth).
- **The "show me the plan first" approval pause** — a later flag.
- **Unified state-dispatch / daemon / poll cadence / worktree concurrency** — PRD-0005.
- **Triage automation** (T2–T8) — out of the front bookend's headless half.

## 9. Verification (Q8)

- **Unit (over fakes, deterministic, CI):** slice-plan schema validation; `dependsOn`
  index → issue-number resolution + `## Blocked by` emission; per-child dedup; the
  deterministic `effort:high` smell + the escalate-if-either combine; the cost formula
  (effort→tokens × price × rework); plan-gate clear vs escalate branching; parent-role
  idempotency gate.
- **Live (sandbox, acceptance evidence):** a canned tiny PRD in the sandbox →
  `flowd plan --issue <n> --prd <path>` → assert child Items created with valid agent-ready
  contracts + the acceptance Item + parent `tracking` + track branch created + estimate
  posted; plus a **handoff smoke** that `flowd run` can *claim* the first produced slice
  (S1), proving the plan→run handoff without re-running 0001's whole build.
- **One-time full-chain evidence (RUNBOOK, not a gate):** at acceptance, one
  PRD → plan → `flowd run` → fixpoint run, confirming the auto-generated slices are
  actually buildable. Recorded in `docs/RUNBOOK.md`, not a repeatable CI gate (slow,
  costly, LLM-flaky).

## 10. Deltas to fold into SPEC.md

- **Plan-gate independence:** invariant #2 (reviewer ≠ implementer, different model) is
  **extended to the plan gate** — `plan-review` ≠ `slice`, different context *and* model
  (§4.3). Fold into SPEC §9 / §5.3.
- **Slice agent is "plan, don't write":** T12's `slice` agent emits a structured plan; the
  **orchestrator** performs the issue writes (already implied by §8.4 — make explicit).

## 11. Proposed slices (the `/to-issues` decomposition will finalize)

Vertical, each independently verifiable, dependency-ordered:

1. **Agent-ready bar doc + profile slot 8** (prerequisite, HITL/`ready-for-human` —
   maintainer owns the contract). Authors `docs/agents/agent-ready-issues.md`; wires the
   profile. No code.
2. **Slice-plan schema + writer (deterministic, over fakes)** — the `submit_slice_plan`
   schema, plan validation, `dependsOn` index→issue resolution, `## Blocked by` emission,
   acceptance-Item creation, parent→`needs-plan-review`, and **per-child dedup**. Unit
   tests, no network, no LLM.
3. **Slice agent session** — the `pi-coding-agent` `slice` session (read-only doc tools)
   that produces the plan via the tool. Verified live: a real PRD → a sane plan.
4. **Plan-review schema + clear/escalate logic (deterministic, over fakes)** — the
   `submit_plan_review` schema, the deterministic `effort:high` smell, the
   escalate-if-either combine, track-branch creation guard, marker comments. Unit tests.
5. **Plan-review agent session (different model)** — the `plan-review` session + the
   `planReview ≠ slice` config guard. Verified live: a sound plan → CLEAR; a plan with an
   `effort:high` leaf or an ADR conflict → ESCALATE with the named risk.
6. **Cost estimator (deterministic flowd capability)** — config tables (effort→tokens,
   model price), the Σ formula + rework multiplier, posted at T13. Unit tests on the
   formula.
7. **`flowd plan` orchestration end-to-end** — compose 2–6 into the command; the full §3
   outcome passes live against the sandbox; re-run is a no-op; the handoff smoke (S1 claim)
   passes.

## 12. Open questions / risks (carry into slicing)

- **Effort→tokens / price tables** are guesses until 0004's meter calibrates them; keep
  them in config (not code) and clearly labelled provisional.
- **Slice agent producing too-coarse or too-fine slices** — the plan-review gate is the
  backstop, but a persistently bad slicer needs a re-slice path; for v1 the human re-slices
  on escalation (T15). Watch in the live run.
- **PRD on disk vs the issue** — the file is the source of truth now; when the grill chat
  lands (later UI track) the PRD will move into the tracker. Keep the reader behind a small
  seam so that swap is a binding change, not a rewrite.
- **`dependsOn` cycles / dangling indices** in the slice plan — validation must reject them
  before any issue is created (fail before side-effects).
