# Flow Harness — Product Design (the AFK app)

The product layer on top of [`SPEC.md`](./SPEC.md). `SPEC.md` is the **lifecycle
machine** (states, transitions, invariants); this document is the **app that runs it
unattended**: a background service + a dashboard, the engine that drives the agents,
the model/cost/identity policy, what you see, and the skills needed to *run* and to
*build* it.

Settled in a design grill (2026-06-14). Where this changes `SPEC.md`, the deltas are
listed in §11 (and folded into `SPEC.md`).

---

## 1. Decision log

| # | Area | Decision |
| --- | --- | --- |
| 1 | **Pipeline** | grill (human, in-app) → **auto-slice** → **agent plan-gate** (routes each slice agent\|HITL; escalates the *plan* only on a smell; optional "show me first") → unattended build → **acceptance** (human). Slicing moves from a human step to automatic. |
| 2 | **Surface** | a dedicated **dashboard**, **tracker-agnostic** through an adapter (GitHub now, Azure DevOps/etc. later), **multi-repo**. |
| 3 | **View** | **who-owns-it** across repos — `NEEDS YOU` / `RUNNING` / `DONE` — with a per-repo **track-focus** mode and **click-through to the real ticket**. |
| 4 | **Grill** | **embedded, doc-aware Pi grill chat**; finishing writes the PRD → fires auto-slice; a direct-PRD form is the quick-path for trivial items. `needs-grilling` is the *common, primary* input channel. |
| 5 | **Topology** | **`flowd`** runs the loop **AFK** (UI closed ≠ work stops); the **dashboard is a thin client**. |
| 6 | **Engine** | **Pi** (`@earendil-works/pi`) on **Bun** — chosen for multi-LLM openness. Custom tools (git/PR, verify-gate shell, in-situ CDP); the reviewer + in-situ patterns ported to Pi. |
| 7 | **Model routing** | **per-role × effort**; the **reviewer always on a different model** than the implementer (independent blind spots, not just fresh context). |
| 8 | **Accept** | **in-app "Accept & merge" as *your* action** (your creds, behind a confirm); the autonomous loop never merges `main`. |
| 9 | **Identity** | **`flow-bot`** (a distinct principal) for all autonomous work; your creds only for accept. The "cannot merge `main`" invariant is enforced by **branch protection on `main`** (excluding `flow-bot`), with `flow-bot` as the excluded principal and "no main-merge code" as defence-in-depth — **not** by token scope (tokens are repo-scoped, not branch-scoped). Multi-repo identity = a **GitHub App**. See **ADR-0038**. |
| 10 | **Cost** | a **per-track pre-flight estimate that *is* the budget**; meter actual vs estimate and **flag, don't stop** (for now); calibrate estimates from accumulated actuals; hard caps are an opt-in later. |

---

## 2. Architecture

```
                         ┌──────────────────────────────────────────┐
                         │  flowd  (Bun service, always-on / AFK)     │
   tracker(s)  ◀───────▶ │   tick loop  → SPEC.md §8                  │
   (GitHub /             │   ├─ tracker adapter (per profile)         │
    Azure / …)           │   ├─ git/forge ops (flow-bot, scoped)      │
                         │   ├─ Pi engine  → spawns role agents       │
   git/forge   ◀───────▶ │   │    grill · slice · plan-review ·        │
                         │   │    implement · review (diff model)      │
                         │   ├─ verify-gate runner (shell)            │
                         │   ├─ in-situ driver (CDP, profile)         │
                         │   └─ cost estimator + meter                │
                         └───────────────▲──────────────────────────┘
                                         │  local RPC seam (Hiss pattern)
                         ┌───────────────┴──────────────────────────┐
                         │  dashboard  (Electrobun · React webview)   │
                         │   NEEDS YOU / RUNNING / DONE · track focus │
                         │   grill chat · accept&merge · cost · drill │
                         └────────────────────────────────────────────┘
```

**State lives in the tracker + git** (SPEC.md §0), so `flowd` stays a stateless
reducer and the dashboard is a pure view/controller over the same source. Neither holds
authoritative state of its own.

### 2.1 UI tech — yes, Electrobun (reuse Hiss)

The dashboard is the *same shape as Hiss*: a React webview + a Bun process + a local
RPC seam. So we reuse the stack and the lessons (§9) rather than reinventing them.

Apply **ADR-0016** (Hiss's cross-shell pattern): the **flow engine is a framework-free
module**; a shell binds it. That makes "where does `flowd` live" a *binding* choice, not
an engine choice:

- **Recommended v1 — one tray-resident Electrobun app.** The Electrobun **Bun process
  runs the `flowd` loop**; the app lives in the **system tray** (the electrobun-skill
  covers trays + service design), so the loop keeps running with the **window closed**;
  opening the dashboard just shows the Mainview window. One thing to build and ship, and
  it reuses every Hiss facility (RPC seam, theming, build/packaging).
- **Escape hatch — split later if AFK persistence needs hardening.** Because the engine
  is a standalone module, it can become a **headless Bun daemon** with the Electrobun
  dashboard as a separate client over the same RPC seam — zero engine rewrite. Take this
  if tray/background lifecycle proves flaky for true overnight runs.

The **`flowd` ↔ dashboard seam reuses Hiss's Mainview↔Bun RPC pattern** (a typed wrapper
client on the webview side, handlers on the Bun side — the "new RPC method" recipe from
`CLAUDE.md`).

---

## 3. The pipeline (with the automation deltas)

```
needs-triage ─(human)→ needs-grilling ─(in-app grill chat, doc-aware)→ PRD
   │                                                                     │
   └─(small/clear)→ ready-for-agent/-human                               ▼
                                                          AUTO-SLICE (Pi slicer)
                                                                         │
                                                                         ▼
                                              AGENT PLAN-GATE (Pi plan-reviewer)
                                       routes each slice: ready-for-agent | HITL
                                       + computes the cost ESTIMATE (= budget)
                                       escalates the PLAN only on a smell
                                       (optional: "show me the plan first")
                                                                         │
                                                                         ▼
                                              AUTONOMOUS BUILD  (SPEC.md §5.4)
                                  per slice: implement → verify → in-situ? →
                                  PR→track → review (different model) → merge
                                                                         │
                                                                         ▼
                                              ACCEPTANCE  (human, in-app)
                                  verify on track branch → Accept & merge (you)
```

Grilling is the recurring human heartbeat; everything from PRD to merged-track is
machine-driven, with HITL only where the plan-gate routes it or a gate fails (§7).

---

## 4. Engine, model routing & cost

- **Pi roles** (each a fresh Pi session = fresh context): `grill`, `slice`,
  `plan-review`, `implement`, `review`. The orchestrator (deterministic `flowd` code)
  spawns them; it **guarantees `review` ≠ the implementer session and a different
  model**.
- **Routing table** (per-role × effort), e.g.:
  - implement: `low → cheap · medium → mid · high → strong`
  - slice / plan-review: `strong`
  - review: `strong`, **constrained ≠ implementer's model** (route to another provider/
    model — Pi's unified API makes this trivial, and the diversity is the safety gain).
- **Cost estimator (pre-flight = budget).** After slicing, `flowd` estimates the track's
  cost from `Σ slices (expected tokens by effort/role × model price)` and surfaces it at
  the plan-gate ("≈ $4.50, 5 slices") — this estimate **is** the budget. During the
  build it meters **actual vs estimate** per slice/track and **flags overruns without
  stopping** (for now). Actuals are recorded to **calibrate** future estimates. A hard
  cap (pause-and-park) is an opt-in once the numbers are trusted.

---

## 5. Identity & credentials

The "harness never merges `main`" invariant is enforced by **three layers, structural
first** (ADR-0038) — **not** by token scope (GitHub token permissions are repo-scoped,
not branch-scoped, so a token cannot express "may merge `track/*` but not `main`"):

1. **Branch protection on `main` (the structural lever).** Require a PR + a non-author
   approval, and **restrict push/merge** to the maintainer (a team excluding `flow-bot`).
   Per-repo config set once; this is what actually makes a `main` merge by the autonomous
   identity impossible. A repo without it has invariant #1 only by code-convention.
2. **`flow-bot` — a distinct principal.** All autonomous actions run as `flow-bot` for
   (a) clean attribution (*"flow-bot built it"*) and (b) being the identity branch
   protection / CODEOWNERS excludes from `main`. **Multi-repo identity = a GitHub App**
   (one App, per-repo installation tokens minted automatically); a single-repo deployment
   may use a bot-account PAT. Tracker writes + track-branch merges are all it ever does.
3. **No `main`-merge code in the autonomous path (defence-in-depth).** flowd never calls
   merge against `main`; the backstop, not the primary guarantee.

- **You** — your forge credentials are used **only** for the in-app **Accept & merge**
  (*"you accepted it"*), which branch protection *does* permit on `main`. The dashboard
  performs that one action under your identity, behind a confirm.
- **Storage** — credentials in the **OS keychain** (the electrobun-skill covers keychain
  integration), per repo/profile.

---

## 6. What you see

- **Board (default, cross-repo):** `NEEDS YOU` (sub-grouped Grill · Accept · HITL ·
  Triage · Escalation), `RUNNING` (by track), `DONE` (recent). Each item badged with its
  repo; click → the real ticket (via adapter).
- **Track focus (per repo):** the slices of one track with progress + its parked items —
  for heads-down work.
- **Slice detail (trust view):** the PR + diff, the **reviewer verdict + findings**, the
  agent transcript, in-situ evidence (e.g. screenshots), and **model / cost / duration**.
- **Cost:** running **actual vs estimate** per slice / track / run.

---

## 7. The smaller policies (recommended defaults)

- **Notifications:** OS/desktop notification + a dashboard badge when an item enters
  `NEEDS YOU`; optional webhook/email later.
- **Failure surfacing:** a red verify gate or repeated `REQUEST_CHANGES` **auto-escalates
  to a `NEEDS YOU` item after N bounded retries** — never a silent loop (and the cost
  meter makes a runaway loop visible as spend).
- **Concurrency:** bounded parallel slices per track via git **worktrees**; the
  **assignee claim is the lock** (SPEC.md §8.3).
- **Drift:** on entering a track, `flowd` merges `main` into the track branch (SPEC.md
  S0).

---

## 8. Skills

Two distinct sets: what the **app needs at runtime** (built into `flowd` as Pi
skills/tools) and what's needed to **develop the app**.

### 8.1 Skills the app needs at RUNTIME (Pi skills/tools inside `flowd`)

| Capability | Form | Notes |
| --- | --- | --- |
| **grill (doc-aware)** | Pi skill + repo-doc read tools | the interview behaviour of `grill-with-docs`, reconciling against `CONTEXT.md`/ADRs; writes the PRD. |
| **slice** | Pi skill | PRD → child slice issues (the `to-issues` behaviour), each with the agent-ready contract. |
| **plan-review** | Pi skill | validate slices vs the agent-ready bar, route agent\|HITL, judge escalation smells, emit the cost estimate. |
| **implement** | Pi coding agent (core) | write the slice, green the verify gate, per-slice doc duty. |
| **review** | Pi skill | independent, fresh-context, **different model**; structured `APPROVE`/`REQUEST_CHANGES` verdict (the `code-review` behaviour ported). |
| **in-situ verify** | Pi tool (profile-supplied) | drive the real app for UI/device-bound checks. For **Electrobun targets** this is the `electrobun-dev` capability (CDP driver) ported as a Pi tool. |
| **tracker adapter** | tool | read/write/parse the board; one per backend (GitHub now). |
| **verify-gate runner** | tool | run the profile's gate command (shell). |
| **git/forge ops** | tool | branch/commit/push/PR/merge(track only)/close, as `flow-bot`. |
| **cost meter/estimator** | `flowd` capability | not an agent skill; meters tokens × price. |

`review` and `in-situ verify` are the two patterns explicitly **ported from Claude Code
skills into Pi** (called out as the cost of choosing Pi).

### 8.2 Skills needed to DEVELOP the app

| Skill | Use |
| --- | --- |
| **electrobun-skill** (`github.com/marketcalls/electrobun-skill`) | building the Electrobun dashboard: API (BrowserWindow/BrowserView), **RPC patterns**, **trays + service design**, multi-window, **build/bundling/distribution**, **keychain**, security/perf. Directly covers the tray-resident-service shape (§2.1) and credential storage (§5). |
| **electrobun-dev** (Hiss) | live in-situ debugging of the dashboard's webview over CDP (screenshot/eval/snapshot/logs/click/type) — same tool the app uses at runtime for in-situ verification; dogfood it while building. |
| **flow** (this lifecycle) | **dogfood**: build `flowd` itself *through* flow (grill → slice → build → accept). |
| **code-review** | review the harness's own PRs (fresh context). |
| **grill-with-docs / to-prd / to-issues** | spec and slice the harness's own work. |
| **Pi SDK docs** (`/earendil-works/pi`) | building on `@earendil-works/pi-coding-agent` + `pi-ai` (sessions, `defineTool`, `ModelRegistry`, `getModel`/`stream`). |

Note the symmetry: the app **automates** flow; you **build** it **using** flow + the
Electrobun skills.

---

## 9. Electrobun lessons to carry over (from Hiss)

Hard-won in this repo — apply them from day one in the dashboard:

- **Make the host `bun.exe` DPI-aware.** A DPI-unaware host gives a blank window
  ("Failed to create WebView2 controller `0x8007139F`"); WebView2 now rejects it. Not a
  runtime/reboot issue — fix the host's DPI awareness. (Hiss memory: *Blank window =
  DPI-unaware bun.exe*.)
- **Get the CSP right for the RPC socket.** A blocked RPC `ws://`/`wss:` shows up as
  *packaged-only* UTF-8 mojibake, not an obvious socket error. Set `connect-src` to allow
  the RPC socket scheme. (Hiss memory: *CSP blocks RPC socket → UTF-8 corruption*.)
- **Reuse the Mainview↔Bun RPC seam** (ADR-0016 + the `CLAUDE.md` "new RPC method"
  recipe): a typed wrapper client on the webview side, handlers on the Bun side — apply
  it verbatim to the `flowd` ↔ dashboard seam.
- **In-situ debug gotchas** (`electrobun-dev` `cdp.ts`): React inputs need the **native
  value setter** (not direct `.value`); wrap every `eval` in an **IIFE** (a global
  `const` persists across calls and collides); verify **VISIBLE**, not merely clickable.
- **WebView2 ≠ full Chrome — expect embedder gaps.** Permission/device APIs behave
  differently (e.g. `enumerateDevices` redaction, mic-permission persistence — Hiss #511).
  The dashboard is unlikely to need media devices, but treat any WebView-platform API as
  "verify on WebView2," not "assume Chrome."
- **Keep the engine framework-free (ADR-0016)** so the tray-app↔daemon split (§2.1)
  stays a binding choice.

---

## 10. Open / deferred

- Hard cost caps (pause-and-park) — opt-in once estimates are calibrated.
- Daemon split — only if tray/background AFK persistence proves insufficient.
- Additional tracker adapters (Azure DevOps, …) beyond GitHub.
- The escalation smell-set and the effort→model map will firm up with use (mirrors
  ADR-0036's open questions).

## 10a. Lessons from dogfooding (PRD-0003)

Building the front bookend *through* the harness (flowd-on-flowd) taught us things that
shape model and operational policy. The mechanical fixes are codified in `SPEC.md`
(§5.4/§5.5/§7/§8.8); the judgment calls live here:

- **The implementer model must meet the reviewer's bar.** The different-model reviewer is
  the safety property — and it is genuinely strong (it caught a stubbed adapter that broke a
  real-tracker dedup, a missing sandbox-isolation guard, dead code). But a *weaker*
  implementer cannot satisfy a *thorough* reviewer within the iteration cap: such slices
  park for a human instead of converging. Route `implement` to a model at least as capable
  as `review`; treat persistent REQUEST_CHANGES as a model-strength signal, not just a
  bounded loop. The effort→model map (§4) should bias `implement` up, not down, for
  reasoning-heavy slices.
- **Static gates can't see integration; the live acceptance run is non-negotiable.** Unit +
  lint + type + independent review all passed while the integrated command was broken
  (throwing stubs only faked in tests; an invalid CLI flag). Only running the real command at
  acceptance surfaced it. The acceptance bookend must exercise the integrated feature for
  real (SPEC §5.5).
- **Self-modification gotcha: config schema drift.** When a slice extends the harness's *own*
  config contract (e.g. a new required model role), the running config goes stale and the
  *next* run fails to parse until the operator updates it. Expect this when a tool builds
  itself; surface it as a clear config error, and update the config as part of landing such a
  slice.
- **The `/flow` skill is the harness's maintenance loop.** Issues found by *operating* the
  shipped harness are first-class input; fixing the harness runs the same triage → build →
  review → accept loop, entered from operation. (Now a workflow in the skill.)

---

## 11. Deltas folded into `SPEC.md`

- **Slicing is automatic** (T12: actor HUMAN → agent `slice`, triggered by PRD
  completion); the front human step is the grill only.
- **Reviewer invariant strengthened**: `reviewer ≠ implementer` → *and a different
  model*.
- **Cost estimator** added as a plan-gate output + a build-time meter.
- **`flow-bot` distinct identity** added; main-merge enforced by **branch protection on
  `main`** (excluding `flow-bot`), not token scope — with "no main-merge code" as
  defence-in-depth (ADR-0038). Multi-repo identity = a GitHub App.
- This product tier (dashboard / `flowd` / Pi / adapter / Electrobun) referenced from
  `SPEC.md` §6/§8.
