# PRD-0004 — Back bookend (headless): acceptance + `flow-bot` identity + cost meter

**Status:** ready to slice (grilled 2026-06-16, `/grill-with-docs`)
**Tracker:** [#105](https://github.com/CaribouJohn/pi-flow/issues/105) (`needs-grilling` → this PRD lands it in `needs-slicing`)
**Parent design:** [SPEC.md](../SPEC.md) §5.5 (A1–A3 + merge boundary), §9 invariant #1, §6 slots 10/11, §4 · [HARNESS-DESIGN.md](../HARNESS-DESIGN.md) §4 (cost), §5 (identity & creds) · [ADR-0038](../adr/0038-flow-bot-identity-main-merge-enforcement.md)
**Builds on:** PRD-0001 (`flowd run` build loop) + PRD-0003 (`flowd plan` front bookend + the deterministic cost *estimator*); reuses `packages/flow-engine` + `packages/flowd-cli`.

---

## 1. Why this next

PRD-0001 shipped the autonomous **middle** (`flowd run`), PRD-0003 the front **bookend**
(`flowd plan`). What's missing is the **back bookend** — the human-owned acceptance gate
(A1–A3) that closes the lifecycle loop — plus the two pieces of safety machinery autonomous
operation needs before it can be trusted unattended: the **distinct `flow-bot` identity**
that makes "the harness never merges `main`" structurally enforceable (ADR-0038), and the
**cost meter** that measures real spend against the PRD-0003 estimate.

This was validated by dogfooding: the self-maintenance track (#125) reached fixpoint
autonomously, and acceptance was performed **by hand** — a human opened the track→main PR
and merged it. This track makes that mechanical (flowd opens the PR + the summary) while
keeping the merge itself human, and turns ADR-0038 from prose into a checked precondition.

## 2. Scope boundary (decided in the grill, Q1)

**Headless back bookend only.** The in-app **"Accept & merge" button** — the maintainer
performing the `main` merge inside the dashboard under their own creds, behind a confirm —
is **UI-bound and deferred to ride with PRD-0002's dashboard**. For this track, A2 (the
merge) is done by the maintainer via `gh`/the GitHub UI, exactly as in the #125 dogfood.
flowd's mechanical role is A1 (open/stage the PR + summary) and A3-capture (`flowd reject`);
the merge and the verification judgement stay human. Same engine-before-pixels call as 0003.

This track delivers three threads:
- **Acceptance A1/A3 (headless)** — `flowd accept` and `flowd reject` commands.
- **`flow-bot` identity + branch-protection enforcement** (ADR-0038, single-repo bot-PAT).
- **Cost meter** — actual vs estimate, recorded + surfaced, with a manual calibration report.

## 3. The outcomes (definition of done)

Three commands, all against the **sandbox repo** for CI evidence and **pi-flow itself** for
the dogfood:

```
flowd accept   --track <n>              # A1: open track→main PR + acceptance summary; park for human
flowd reject   --track <n> --reason ... # A3: file a corrective slice (needs-triage) on the track; keep it open
flowd calibrate                         # read cost-history.jsonl, print suggested table values (mutates nothing)
```

and autonomous work (`flowd run`/`plan`) runs as the **`flow-bot` principal**, metering its
own spend.

### 3.1 `flowd accept --track <n>` (A1)
When all non-acceptance slices of the track are closed, the command:
1. **Verifies the branch-protection precondition** (Q4) — queries `main`'s protection via
   the forge; if it does not restrict merge away from the bot actor, includes a loud
   `⚠ main is not protected against <actor>` line in the summary (does **not** block).
2. **Composes a deterministic acceptance summary** (Q7) — see §4.5 — from data flowd
   already holds: merged slices, each slice's harvested `## Acceptance criteria`, the verify
   command, the **mandatory live end-to-end exercise reminder** (SPEC §5.5), and the cost
   roll-up (actual vs estimate).
3. **Opens (does not merge) the track→main PR** with that summary, `Closes` the parent + the
   acceptance Item, and **notifies** the maintainer. It then parks — *even if told to merge*
   (the inviolable boundary, SPEC §5.5/§9 #1).

Re-running is idempotent: if the PR already exists it updates the summary, never duplicates.

### 3.2 `flowd reject --track <n> --reason <text>` (A3)
Files a **corrective slice issue on the track branch** carrying the `--reason` + the failure
evidence + the "add the coverage that would have caught it" note, links the acceptance Item,
keeps the track open — and lands it in **`needs-triage`, not `ready-for-agent`** (Q8). The
`/flow` skill (or the maintainer) then sets exact files + a named verification method +
effort to clear the **agent-ready bar** (PRD-0003's `docs/agents/agent-ready-issues.md`)
before `flowd run` picks it up. The command captures the rejection fast **without bypassing
the bar** — a freeform reason cannot define files/verification, so triage stays a human/skill
step. `flowd accept` then re-presents (A1) once the corrective merges.

### 3.3 Identity (ADR-0038)
Autonomous work runs as a **distinct `flow-bot` principal** so branch protection on `main`
can structurally exclude it (layer 1) while permitting the maintainer's merge.

### 3.4 Cost meter
Every slice's **real** implement + review spend (from Pi's `usage.cost`) is compared to its
estimate, **posted to the tracker**, appended to a committed **`.flowd/cost-history.jsonl`**,
rolled up in the acceptance summary, and **flagged on overrun without stopping** the build.

## 4. Architecture & key decisions (settled in the grill)

### 4.1 `flowd accept` — a separate one-shot command (Q2)
Symmetric with `plan`/`run` (PRD-0003 §4.7). A2 (merge) and A3 (reject→corrective) are
**human-driven**, so they cannot live inside the autonomous `run` loop; `run` ends at
fixpoint emitting *"track ready for acceptance — run `flowd accept`"*. Single-purpose
commands; unified state-dispatch is still PRD-0005's daemon job.

### 4.2 Identity — single-repo `flow-bot` bot-account PAT (Q3)
A **distinct GitHub machine-user account** (`flow-bot`-style), added as a collaborator, with
its own PAT in `.flowd/credentials.json`; flowd's `actor` becomes that account. ADR-0038
explicitly sanctions a bot-account PAT for the single-repo case and reserves the **GitHub
App** (per-repo installation tokens) for multi-repo — deferred, recorded so it isn't
re-litigated. A PAT does not create identity; the *account* is the identity, the PAT
authenticates as it — so **creating the account + generating the PAT is a `ready-for-human`
leaf** (external, physical), paired with agent slices that make flowd *use* the new actor.
The **AI disclaimer simplifies** once the author is visibly the bot: from
`🤖 Posted by pi-flow on behalf of @CaribouJohn` to `🤖 pi-flow (automated)` (the "on behalf
of" was a workaround for the author being the human).

### 4.3 Branch-protection enforcement — verify + warn (Q4)
ADR-0038 makes branch protection the **structural lever** (layer 1) and a **setup
precondition**; today nothing checks it. `flowd accept` queries `main`'s protection via a new
`ForgePort.getMainMergeRestriction()` and, if merge isn't restricted away from the bot actor,
**warns loudly in the summary but still opens the PR** (so a sandbox/test repo with no
protection isn't blocked). This makes the precondition observable rather than a doc footnote;
hard-fail was rejected as too brittle for dogfooding.

### 4.4 Cost meter — actuals from Pi, not the estimate tables (Q5)
Pi attaches a `usage` object to **every** assistant message with token counts **and a
computed dollar `cost`** (`input/output/cacheRead/cacheWrite/total`). So **actuals come
straight from Pi** — flowd sums `usage.cost.total` across a slice's implement + review
sessions. The PRD-0003 estimate tables (`effortTokens`, `modelPrices`) stay **only** for the
pre-flight *estimate*; they are not reused for actuals. The current
`CodingSession.prompt(): Promise<void>` seam discards usage, so the foundational engine
change is to **thread `Usage` out of the session** (via the existing `subscribe` stream /
`getLastAssistantUsage`) and accumulate per role-session.

Per slice at merge: post a tracker comment `cost: actual $X vs est $Y (±Z% [⚠])` and append a
record `{ slice, effort, role, model, tokens, costUSD, estUSD, ts }` to a **committed
`.flowd/cost-history.jsonl`** on the track branch (machine-readable, accrues across runs).
Overrun past a **configurable threshold** gets the `⚠`; the build **never stops** (a hard
cap is opt-in once numbers are trusted — HARNESS-DESIGN §4, deferred). The acceptance summary
carries the **track-level roll-up**.

### 4.5 Acceptance summary — deterministic, harvested from slices (Q7)
No agent call. flowd builds the summary from data it already has: the merged slice list, each
slice's `## Acceptance criteria` checkboxes harvested from its issue body, the verify-gate
command, a **mandatory `LIVE: run the real entry path end-to-end`** checkbox (SPEC §5.5 — the
gate stays green while integrated behaviour is broken), the cost roll-up, and the
branch-protection warning if any. Fast, cheap, reproducible — fitting for a mostly-mechanical
bookend.

### 4.6 Reject lands in `needs-triage` (Q8)
See §3.2. The command exists for fast capture; the **agent-ready bar is preserved** by
routing through triage. This reconciles the convenience of a one-liner with the PRD-0003 bar
discipline (a freeform `--reason` cannot satisfy "exact files + named verification method").

## 5. Model routing & config

No new LLM role agents — acceptance and the meter are **deterministic flowd capabilities**
(HARNESS-DESIGN §4/§8.1); the cost meter only *reads* usage from the existing implement/review
sessions. Config additions: `actor` already exists (point it at `flow-bot`); add
`costMeter` (overrun threshold, history-file path) and reuse the ported credential store. The
`flow-bot` PAT is a new key in `.flowd/credentials.json`.

## 6. Invariants this PRD must honour (SPEC §9)

- **The harness never merges `main`** (invariant #1) — `flowd accept` opens/stages the
  track→main PR and **parks for the human even when told to merge**; there is **no
  main-merge code path** in the autonomous service. Enforced structurally by branch
  protection (layer 1, now *verified*), identity (layer 2), no-merge-code (layer 3).
- **Orchestrator owns all tracker writes** — the cost comments, acceptance summary, and
  corrective-slice creation are all flowd writes; each carries the AI-disclaimer prefix.
- **Agent-ready bar is never bypassed** — `flowd reject` lands corrective slices in
  `needs-triage`, not `ready-for-agent`.
- **Acceptance is more than the gate** — the summary makes the **live end-to-end exercise
  mandatory** (SPEC §5.5); a defect caught live that the gate missed must, in its corrective,
  add the coverage that would have caught it.
- **Idempotency** (SPEC §8.8) — `flowd accept` updates an existing PR rather than duplicating;
  cost records are keyed by slice so a re-run doesn't double-count.

## 7. Non-goals (deferred to later PRDs)

- **In-app "Accept & merge" button** + keychain credential storage — PRD-0002 (dashboard).
- **GitHub App identity** (per-repo installation tokens, multi-repo) — when pi-flow goes
  multi-repo; ADR-0038 records the choice.
- **Hard cost cap (pause-and-park)** — opt-in once estimates are trusted (HARNESS-DESIGN §4).
- **Automatic table calibration** — `flowd calibrate` is read-only/manual for v1 (Q6); the
  spend-gating number is never mutated without the maintainer's eyes.
- **Unified state-dispatch / daemon / poll cadence** — PRD-0005.

## 8. Verification

- **Unit (over fakes, deterministic, CI):** acceptance-summary composition (harvest slice
  criteria + verify cmd + cost roll-up + protection warning + live-exercise line); the
  branch-protection verify-and-warn branch; PR open-not-merge + idempotent re-run; cost
  actual-vs-estimate compare + overrun-flag threshold; `cost-history.jsonl` append/keying;
  `flowd reject` files a `needs-triage` corrective with evidence and keeps the track open;
  `flowd calibrate` suggestion math; config validation for the new keys.
- **Live (sandbox, acceptance evidence):** a done sandbox track → `flowd accept` opens the
  track→main PR with a correct summary + cost roll-up and parks (does not merge); `flowd
  reject --reason` files the corrective in `needs-triage`; a metered `flowd run` writes a real
  `cost-history.jsonl` line and a per-slice cost comment; running as the `flow-bot` actor,
  tracker writes show the bot author.
- **One-time full-chain evidence (RUNBOOK):** the pi-flow dogfood — a real track through
  `plan → run → accept`, the maintainer merges, with the cost meter populated and the
  branch-protection check passing against pi-flow's actual `main` protection.

## 9. Deltas to fold into SPEC.md / HARNESS-DESIGN.md

- **Branch-protection precondition is verified, not assumed** — `flowd accept` checks it and
  warns (§4.3). Fold into SPEC §5.5 / §6 slot 10 and HARNESS-DESIGN §5.
- **`flowd accept` auto-opens the PR** — the agent opens, the maintainer merges (already
  reflected in the `/flow` skill acceptance step; make explicit in SPEC §5.5 A1).
- **Cost actuals come from Pi `usage.cost`, not the estimate tables** — record to
  `.flowd/cost-history.jsonl` + tracker; `flowd calibrate` is the manual feedback loop
  (HARNESS-DESIGN §4).

## 10. Proposed slices (the `/to-issues` decomposition will finalize)

Vertical, each independently verifiable, dependency-ordered:

1. **Stand up `flow-bot` + branch protection** (`ready-for-human`, HITL — external/physical).
   Create the machine-user account, add as collaborator, generate its PAT, set branch
   protection on `main` restricting merge to the maintainer, drop the PAT in
   `.flowd/credentials.json`. No code; the prerequisite for the identity slices.
2. **flowd runs as the distinct actor + disclaimer simplified** — autonomous git/gh/tracker
   ops authenticate as `flow-bot`; AI disclaimer → `🤖 pi-flow (automated)`. Verified live:
   tracker writes show the bot author. (Depends on 1.)
3. **Thread Pi `Usage` out of the session seam + cost meter** — extend `CodingSession` to
   surface `usage` (tokens + `cost`); accumulate per implement/review session; compare actual
   vs estimate; post the per-slice cost comment; append `.flowd/cost-history.jsonl`; overrun
   `⚠` past the configurable threshold (no stop). Unit over fakes + a live metered run.
4. **`flowd calibrate`** — read `cost-history.jsonl`, print suggested table values vs config,
   mutate nothing. Unit on the suggestion math. (Depends on 3 for the data shape.)
5. **Branch-protection verify + warn** — `ForgePort.getMainMergeRestriction()` + the
   verify-and-warn logic surfaced in the acceptance summary. Unit over fakes.
6. **`flowd accept --track` (A1) end-to-end** — compose the deterministic summary (harvest
   slice criteria + verify cmd + cost roll-up from 3 + protection warning from 5 + mandatory
   live-exercise line), open-not-merge the track→main PR, notify, idempotent re-run. Live
   against the sandbox. (Depends on 3, 5.)
7. **`flowd reject --track --reason` (A3)** — file the corrective slice in `needs-triage` with
   evidence + missing-coverage note, link the acceptance Item, keep the track open. Unit over
   fakes + live. (Depends on the tracker-write plumbing.)

## 11. Open questions / risks (carry into slicing)

- **Pi `usage` surfacing across the seam** — confirm the per-message `usage.cost` totals
  reconcile with provider billing on the live run; if Pi only emits usage on certain events,
  the accumulator must subscribe correctly (verify in slice 3's live run).
- **Branch-protection API shape** — GitHub's protection/rulesets API has two surfaces
  (classic branch protection vs rulesets); the `ForgePort` method must handle whichever
  pi-flow's `main` actually uses (probe during slice 5).
- **`flow-bot` collaborator + protection interaction** — confirm a restricted-merge rule on
  `main` that excludes `flow-bot` still lets the maintainer's `gh` merge through (test on the
  pi-flow dogfood before relying on it).
- **cost-history.jsonl churn** — committed on the track branch; ensure the append is a clean,
  diff-friendly one-line-per-record so it doesn't create noisy merge conflicts between
  sibling slices (consider writing it only at `accept`/merge time, not mid-implement).
