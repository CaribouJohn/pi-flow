# PRD-0005 — Continuous daemon (headless): always-on tick loop + trust surface

**Status:** ready to slice (grilled 2026-06-16, `/grill-with-docs`)
**Tracker:** [#106](https://github.com/CaribouJohn/pi-flow/issues/106) (`needs-grilling` → this PRD lands it in `needs-slicing`)
**Parent design:** [SPEC.md](../SPEC.md) §0 (stateless reducer / resumability), §8.2 (the tick), §8.5 (human bookends), §8.7 (failure handling), §8.8 (idempotency) · [HARNESS-DESIGN.md](../HARNESS-DESIGN.md) §2.1 (topology / tray-resident), §7 (smaller policies) · [ADR-0016](../adr/0016-shell-agnostic-state-native-reactivity.md) (framework-free engine) · [ADR-0036](../adr/0036-autonomous-track-execution.md)
**Builds on:** PRD-0001 (`flowd run` build loop) + PRD-0003 (`flowd plan` front bookend) + PRD-0004 (`flowd accept` back bookend); reuses `packages/flow-engine` (`decide`, `runTrack`, `readWorld`) + `packages/flowd-cli`.

---

## 1. Why this next

PRD-0001/0003/0004 shipped the three lifecycle stages as **one-shot CLI verbs** (`flowd
run`/`plan`/`accept`), each driven by hand. PRD-0005 turns them into a **real AFK
service**: an always-on process that re-reads the world on a cadence, drives every
agent-runnable step to a fixpoint, parks the irreducible human steps, and keeps running
with no operator at the keyboard.

The engine already holds the stateless pieces a daemon needs — `decide(world)` (the pure
reducer), `runTrack(...)` (drives a track to fixpoint or park, holding **no** state between
ticks), `readWorld(...)` (fresh read each tick). So the daemon is largely "wrap the tick in
a sleep loop over all active tracks, with observability and resumption." The genuinely
novel parts are the **continuous lifecycle**, **observability**, and **failure resilience**.

## 2. The anchor: *run it and be sure it's working as designed*

The maintainer's stated goal is not throughput — it is **trust**. A headless daemon is
invisible by default, so this PRD elevates **observability and a thin, verifiable v1** over
feature-completeness. Every scope call below resolves toward "smallest thing I can run and
*know* is correct," and the daemon's own acceptance bar (§6) makes that trust demonstrable
and repeatable.

## 3. Scope boundary (decided in the grill)

**Headless, single-threaded, full-pipeline v1.** The daemon is a `flowd daemon` CLI
process — no UI. It drives the **complete SPEC §8.2 tick** (auto-slice T12, plan gate
T13/T14, build S0–S8, accept-stage A1) over **all active tracks in one repo**,
**single-threaded** (one slice at a time to fixpoint, no worktrees). Same
*engine-before-pixels* call as 0003/0004.

**Explicitly deferred (out of v1):**

| Deferred | Why / where it lands |
| --- | --- |
| **Worktree concurrency** (parallel slices, per-track merge serialization) | The scariest novel part; multiplies failure modes exactly where we want certainty. A separate, measured phase (candidate PRD-0006) once the serial loop is trusted. The assignee-claim lock (S1) stays as the seam it slots into. |
| **Tray / Electrobun binding** | §2.1's *recommended* topology — but it couples "is the daemon alive?" to a UI lifecycle and pulls in the unbuilt PRD-0002 shell. The framework-free engine (ADR-0016) makes binding the daemon into the tray a pure addition later, with zero engine rewrite. |
| **Native OS notifications + dashboard badge** | §7 policy; needs platform-specific code from a headless process. Rides with the tray app (PRD-0002). |
| **Outbound webhook push, multi-repo, OS-service/boot-persistence, event-driven webhooks, hard cost caps** | Later optimizations; none is needed to run-and-trust a single-repo daemon. |

> **Doc reconciliation.** HARNESS-DESIGN §2.1 recommends a tray-resident Electrobun app
> for v1 with a "split to a headless daemon later" escape hatch. PRD-0005 takes the
> **escape hatch as the front door** (headless first, tray binding later) for the reasons
> above. §2.1 should get a one-line note pointing here. No ADR needed — this extends
> ADR-0016 (the binding is an engine-free choice) and does not conflict with it.

## 4. The decisions (grill Q&A)

| Q | Decision | Rationale |
| --- | --- | --- |
| **Q1 Topology** | **Headless `flowd daemon`**, no UI; tray binding deferred | engine-before-pixels; PRD-0002 unbuilt; minimize the surface between operator and "is it running?" |
| **Q2 Trust surface** | **structured per-tick logs + a heartbeat the daemon writes each tick + a `flowd status` CLI** | status recomputes the world from tracker+git (the §0 gift) and reads the daemon **only** for liveness — so it reports "alive / stale / dead" even when the daemon is down. No HTTP server. |
| **Q3 Tick model** | **fixed idle poll (profile `poll_cadence_seconds: 30`) + error-only exponential backoff** | while agent-runnable work exists the loop never sleeps (drives to fixpoint); the cadence governs only the *idle* re-check for external changes. Fixed = predictable latency = trustworthy. Backoff applies to transient errors only, never idle. Event-driven webhooks deferred. |
| **Q4 Concurrency** | **single-threaded v1; worktrees deferred** | "slow but certain" over "fast but uncertain"; don't debug parallelism and continuous-lifecycle at once. |
| **Q5 Pipeline scope** | **full SPEC §8.2 tick, all tracks, single repo** | drive the real machine end-to-end; park only the irreducible human steps (§10). |
| **Q6 Lifecycle** | **foreground process + graceful SIGINT/SIGTERM shutdown**; crash-resume free (§0) | observable; abandon-mid-step is safe (re-derives); boot-persistence is the tray app's job. |
| **Q7 NEEDS YOU surfacing** | **`flowd status` section + a log line on entry** (pull) | minimal; native toast/webhook deferred to the tray app. |
| **Q8 Failure policy** | **classify: transient → capped backoff + "degraded" status (retry); fatal → halt + loud error** | overnight-resilient (a GitHub blip won't kill it) yet screams on real breakage (broken PAT, 404 repo, config parse). Honors §8.7 "never a silent loop." |
| **Q9 Acceptance bar** | **property tests + a scripted, repeatable live exercise** | the recursive payoff: prove "trust the daemon" by *demonstrating* it (§6). |

### 4.1 Error classification (Q8)

- **Transient** (retry, capped exponential backoff, surface a `degraded` status, never
  halt): network errors, HTTP 5xx, 429 rate-limit, timeouts.
- **Fatal** (halt the loop, write a loud error to status/log/heartbeat, exit non-zero):
  auth 401/403, repo 404, config parse/validation errors, missing credential.
- Per-slice failures (verify red, repeated `REQUEST_CHANGES`) are **not** daemon errors —
  they already park into NEEDS YOU bounded by `reviewerIterationCap` (existing behavior).

### 4.2 The heartbeat (Q2)

A small **operator-local, uncommitted** liveness record (e.g. `.flowd/daemon-heartbeat.json`,
gitignored — *not* committed; cf. the #159 path lesson) written each tick: last-tick
timestamp, current activity (`idle` / `driving track #n` / `degraded` / `halted`),
consecutive-error count, pid. `flowd status` reads it for liveness; staleness (last tick
older than ~2× cadence) ⇒ "stale/dead."

## 5. The outcomes (definition of done)

Two new verbs, against the **sandbox repo** for CI evidence and **pi-flow itself** for the
dogfood:

```
flowd daemon          # always-on: tick → drive all tracking tracks (full §8.2 pipeline)
                      #            to fixpoint → write heartbeat → sleep poll_cadence → repeat
                      # SIGINT/SIGTERM → graceful shutdown
flowd status          # point-in-time: recompute the world from tracker+git + read the
                      # heartbeat → tracks, slice states, NEEDS YOU, daemon liveness
```

`flowd status` works **with or without** a running daemon (it's a read-only world+liveness
query). The daemon reuses the existing one-shot internals (`runTrack`, `runPlan`,
`acceptTrack`) — it is the loop *around* them, not a reimplementation.

## 6. Acceptance bar (Q9 — the trust demonstration)

Beyond unit/integration coverage of the testable parts (tick→action mapping, status
computation, error classification, backoff timing, idempotent resume), acceptance requires
a **documented, repeatable live exercise** against a real track:

1. **Drives to fixpoint unattended** — start the daemon on a track with assignable slices;
   it builds them to fixpoint with no intervention; `flowd status` reflects each transition.
2. **Resumes after a kill** — `kill -9` mid-build, restart; it re-derives and continues with
   **no double-pick** (claim-lock + §8.8 idempotency), no duplicate PR/comment.
3. **Picks up idle external changes** — while idle, change the tracker (approve a PR / close
   a dependency); within `poll_cadence` the daemon notices and advances.
4. **Backs off vs halts correctly** — inject a transient error (it retries, shows
   `degraded`) and a fatal error (it halts loudly, status shows the cause).
5. **Observable throughout** — heartbeat updates each tick; `flowd status` shows
   "alive/stale/dead" and the NEEDS YOU set matching reality.

A defect found live that a test missed must, per SPEC §5.5, add the coverage that would
have caught it.

## 7. Proposed slice sketch (to firm up at `/to-issues`)

Vertical, dependency-ordered:

1. **`flowd status`** — world snapshot (all `tracking` tracks + slice states + NEEDS YOU)
   from tracker+git, + liveness from the heartbeat file. *Foundational, independently
   useful, no daemon required.* `effort:medium`.
2. **`flowd daemon` core (single track)** — wrap `runTrack`: tick → fixpoint → write
   heartbeat → sleep `poll_cadence` → repeat; SIGINT graceful shutdown; structured per-tick
   logs. Start with one track to keep it thin. `effort:medium`. *Depends on #1 (heartbeat).*
3. **All-tracks scope** — derive all `tracking` parents; drive each sequentially per cycle.
   `effort:low`. *Depends on #2.*
4. **Full-pipeline tick** — add T12 auto-slice (needs-slicing + PRD; pin the PRD-location
   convention), T13/T14 plan gate (needs-plan-review), A1 accept-stage on track completion —
   the complete §8.2 tick over all agent-runnable items. `effort:medium`. *Depends on #3.*
5. **Error classification + backoff + degraded/halt** — transient vs fatal (§4.1); heartbeat
   reflects `degraded`/`halted`. `effort:medium`. *Depends on #2.*
6. **NEEDS YOU surfacing** — status section + log-on-entry for human-bookend states.
   `effort:low`. *Depends on #1, #2.*
7. **Scripted live-acceptance exercise** — the §6 repeatable trust demonstration as the
   acceptance issue's checklist + any test scaffolding (kill/restart, error injection).
   `effort:medium`. *Depends on the rest.*

## 8. Invariants carried (unchanged)

Daemon operation changes *cadence*, not the rules: the harness still never merges `main`
(A1 stages, the human merges); reviewer ≠ implementer, different model; never merge past a
red gate; claim-before-work; every tracker write carries the AI-disclaimer; idempotent
ticks (§8.8). The daemon is the loop *around* the existing safety machinery, adding none of
its own state.
