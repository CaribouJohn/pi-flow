# PRD-0002 — Read-only board (the first pixels): NEEDS YOU / RUNNING / DONE

**Status:** ready to slice (grilled 2026-06-17, `/grill-with-docs`)
**Tracker:** [#103](https://github.com/CaribouJohn/pi-flow/issues/103) (`needs-grilling` → this PRD lands it in `needs-slicing`)
**Parent design:** [HARNESS-DESIGN.md](../HARNESS-DESIGN.md) §2.1 (UI tech / reuse Hiss), §3 (pipeline), §6 (what you see), §7 (notifications/failure), §9 (Electrobun lessons) · [SPEC.md](../SPEC.md) §0 (one source of truth), §8.5 (human bookends) · [ADR-0016](../adr/0016-shell-agnostic-state-native-reactivity.md) (framework-free engine) · [ADR-0039](../adr/0039-dashboard-topology.md) (this track's topology)
**Builds on:** PRD-0005 (`flowd daemon` + `flowd status`/`classifyNeedsYou`/heartbeat); reuses `packages/flow-engine` (the `World` reducer + derived-state predicates + `classifyNeedsYou`) and the `runStatus` world-building path it will refactor.

---

## 1. Why this next

PRD-0001/0003/0004/0005 shipped the entire lifecycle as a **headless** engine: `flowd
run`/`plan`/`accept` and an always-on `flowd daemon`, observable through `flowd status`
(text) + a heartbeat file. That is everything *except the pixels*. PRD-0002 is the **first
UI track** — the read-only board that turns "tail the logs / run `flowd status`" into a
glanceable surface and, crucially, **pings you when you're actually needed** while you're
away.

The engine already computes the board. `runStatus` reads tracker+git, builds a `World` per
`tracking` parent via the reducer, and `classifyNeedsYou` already emits the **NEEDS YOU**
set straight from SPEC §8.5. So this track is **not** "derive the board" — it is "render,
supervise, and notify over the world the engine already produces." That framing is what
keeps the first pixels track thin.

## 2. The anchor: *thinnest pixel layer over the existing engine*

The board must never become a **second reducer**. SPEC §0 says state lives in tracker+git
and is derived, never stored; if the webview re-derived `NEEDS YOU / RUNNING / DONE` from
the tracker on its own, we would have two implementations of the lifecycle that drift. So
every decision below resolves toward **reuse the engine's `World` + `classifyNeedsYou`
verbatim**, and toward **moving logic out of React into framework-free, unit-testable
modules** the autonomous loop can verify (the pixels themselves are verified by a human at
acceptance — §6).

## 3. Scope boundary (decided in the grill)

**A single-repo, read-only, tray-resident Electrobun app that supervises the daemon and
renders the engine's world.** New `packages/dashboard`. It does **not** re-derive state, it
does **not** act on the board (no in-app Accept & merge — that is PRD-0004's deferred
maintainer action), and it boards **one repo**.

**Explicitly deferred (out of v1):**

| Deferred | Why / where it lands |
| --- | --- |
| **Multi-repo aggregation** | The §3/§6 "across repos" vision. v1 is single-repo (matches `flowd.config.json`'s single `repo` and everything shipped) but **multi-repo-shaped**: the view model is a `worlds[]` array and every item carries a repo badge, so multi-repo becomes "config takes a repo list + loop the existing single-repo path" — a later additive track, no rework. |
| **In-app Accept & merge** | PRD-0004 deferred the maintainer's in-app merge (under *their* creds) to "the dashboard." It stays deferred: v1 is strictly read-only, so click-through to the real ticket is where acceptance happens. A later track adds the confirm-gated merge button. |
| **Inline diff + agent transcript** | The slice-detail view shows structured trust data inline and **links out** to the PR (diff) and the transcript artifact. A diff renderer + transcript-streaming pipeline is a separate trust-view track. |
| **Push / real-time updates** | The board polls (§4 Q6). Change-detection-and-push is build cost for a read-only v1 that is still forge-poll-bound underneath. |
| **Autonomous in-situ CDP verification** | HARNESS-DESIGN §10 defers it. UI slices verify their *logic* headlessly in the autonomous loop; the *pixels* are verified by a human at the acceptance bookend via `electrobun-dev` (§6). |
| **In-app grill chat** | HARNESS-DESIGN decision #4's embedded Pi grill chat is a much larger interactive track; the board only *surfaces* `needs-grilling` items (click → ticket; you grill via `/grill-with-docs` as today). |
| **OS keychain credential storage** | The viewer reuses flowd's existing `.flowd/credentials.json` path (it runs on the operator's machine alongside the daemon). Keychain integration (§5) rides a later track. |

## 4. The decisions (grill Q&A)

| Q | Decision | Rationale |
| --- | --- | --- |
| **Q1 Data source** | The dashboard's **Bun process imports `flow-engine`'s read path directly** and exposes the world to the webview over the Hiss Mainview↔Bun RPC seam. Lift the world-building loop out of `runStatus` (status.ts) into a reusable `BoardSnapshot` builder both `flowd status` and the board consume. | One source of truth (SPEC §0). Typed end-to-end, no subprocess, no JSON contract to version, no second derivation. Rejected: shelling out to `flowd status --json` (subprocess + schema to maintain), and a daemon-written snapshot file (stale when the daemon is idle/stopped — exactly when an AFK board matters). |
| **Q2 Topology** | Tray app = **supervisor + viewer** (not a pure viewer, not the in-process loop). | Delivers the actual product shape (decision #5: *flowd runs the loop AFK, UI closed ≠ work stops*) rather than a throwaway viewer, while keeping the loop isolated. See ADR-0039. |
| **Q3 Daemon hosting** | The tray app **spawns `flowd daemon` (PRD-0005, unchanged) as a supervised child**: start on launch, surface heartbeat + exit code as liveness, start/stop/restart controls. | A WebView2/Electrobun host crash cannot kill the work (separate process); the daemon still runs standalone from a terminal. Rejected: running the loop in-process (§2.1's literal reading) — a host crash takes the loop down, the precise AFK-persistence hazard PRD-0005 flagged. |
| **Q4 v1 surfaces** | Board (NEEDS YOU sub-grouped / RUNNING by track / DONE recent) · click-through to ticket · daemon liveness + controls · **slice-detail trust view** (structured inline; diff/transcript linked out). | The minimal AFK payoff plus the trust view the maintainer explicitly wanted. |
| **Q5 Trust view depth** | Inline: reviewer verdict + findings, model, cost, duration, PR status — all cheap structured reads. **Link out** to GitHub for the diff and to the transcript artifact. | Delivers "can I trust this slice?" without building a diff viewer or transcript pipeline. Data already exists (tracker comments + `.flowd/cost-history.jsonl` + PR state). |
| **Q6 Refresh** | **Poll** on a modest cadence (default aligned to the daemon idle poll, configurable) + immediate refresh on window-focus + manual refresh button. The heartbeat (cheap file read) refreshes the **liveness badge** faster than the full world. | Read-only-honest, rate-limit-friendly, no change-detection/subscription protocol to build. |
| **Q7 Notifications** | **Tray badge** (Electrobun-native `Tray`) = NEEDS YOU count; **OS notification** fires when a poll reveals a NEEDS YOU item absent last cycle (a set-diff on the poll). OS toasts are delivered through a **native shell-integration element** (see below), *not* `Utils.showNotification`. | The "ping me when needed" AFK payoff, cheap on top of polling. **Correction (slicing):** Electrobun's built-in `Utils.showNotification` does **not** reliably deliver Windows toasts — they won't route without an **AUMID + Start Menu shortcut**, which Electrobun doesn't register. Hiss solved this with a Windows-only Rust `cdylib` (`hiss-native`) loaded via `bun:ffi` (WinRT toast + AUMID + window icon). flowd ports it as `flowd-native` (a dedicated, HITL, foundational slice). This is an **exception to Q8's scaffold-fresh** call — the native crate is copied/ported, not re-implemented. |
| **Q8 Shell** | **Scaffold a fresh `packages/dashboard`** Electrobun app, deliberately applying the Hiss patterns: the Mainview↔Bun RPC seam (ADR-0016 + the "new RPC method" recipe), DPI-aware `bun.exe` host, CSP for the RPC socket (§9). | Minimal, no dead Hiss baggage, forces a clean engine/shell boundary. Rejected: copying the Hiss shell wholesale (imports baggage + Hiss-specific assumptions; needs the source locally). |
| **Q9 UI verification** | The autonomous loop verifies the **headless logic** (`BoardSnapshot` builder, NEEDS YOU set-diff, supervision logic, trust-view assembly, RPC handlers) via `bun run verify`. The **pixels** are verified by a human at the acceptance bookend via `electrobun-dev` (CDP screenshots). | Matches §10 (autonomous CDP deferred) and plays to the agents' strengths; it also *forces* logic out of React into testable modules — the §2 anchor. |

## 5. Architecture (v1)

```
  ┌─ Tray app  (packages/dashboard · Electrobun · Bun process) ──────────────┐
  │                                                                          │
  │  supervisor:  spawn / stop / restart  ──────────▶  child: `flowd daemon` │
  │     │  reads .flowd/daemon-heartbeat.json  ◀──── (writes heartbeat/tick) │
  │     │  reads child exit code → liveness                                   │
  │                                                                          │
  │  viewer (Bun side):  flow-engine.readWorld() + classifyNeedsYou()        │
  │     │  → BoardSnapshot   (own poll cadence; independent of the daemon)    │
  │     │                                                                     │
  │     ▼  Mainview↔Bun RPC seam (Hiss / ADR-0016)                            │
  │  webview (React):  NEEDS YOU / RUNNING / DONE · liveness · slice detail   │
  └──────────────────────────────────────────────────────────────────────────┘
            tracker (GitHub) + git ──── read by BOTH the daemon child (to act)
                                        and the viewer (to display), independently
```

**Two independent readers of the world.** The daemon child reads to *act*; the viewer reads
to *display*, on its own poll cadence. This is intentional — it is why the snapshot-file
option was rejected (the viewer stays live mid-tick and when the daemon is stopped). Both
call the same `flow-engine` read functions, so they never disagree about *what the world
means*, only about *when each last looked*.

## 6. Acceptance bar (the back bookend, `review:human`)

The integrated app, driven for real via `electrobun-dev` (this is also the first time the
in-situ harness is dogfooded against pi-flow's own GUI):

- [ ] App launches tray-resident; closing the window keeps it (and the daemon child) running; quitting the app stops the supervised daemon.
- [ ] Board renders NEEDS YOU / RUNNING / DONE; the **NEEDS YOU set matches `flowd status`** for the same repo state (the two readers agree).
- [ ] Click-through opens the correct real ticket/PR.
- [ ] Daemon liveness badge reflects alive / stale / dead; start/stop/restart works; killing the daemon child is reflected as dead/stale, not a crashed UI.
- [ ] A new NEEDS YOU item (e.g. stage an acceptance) fires **one** OS notification and bumps the tray badge.
- [ ] Slice-detail shows verdict/findings + model/cost/duration inline; diff/transcript links open externally.
- [ ] `bun run verify` green (the headless logic of every slice); §9 lessons applied (no blank window / no RPC-socket mojibake); screenshots captured as evidence.

## 7. Slices (published from this PRD — [#103](https://github.com/CaribouJohn/pi-flow/issues/103) → `/to-issues`)

Ten vertical slices + the acceptance back-gate. The original sketch split into thinner,
independently-verifiable increments, and the **`flowd-native`** slice (#207) was added once
slicing surfaced that OS notifications require a native element (Q7 correction).

| # | Slice | Type | Blocked by |
| --- | --- | --- | --- |
| [#205] | Engine: `BoardSnapshot` builder (status + dashboard) | AFK | — |
| [#206] | Electrobun shell scaffold (RPC seam + DPI host + CSP) | **HITL** | — |
| [#207] | `flowd-native` shell integration (port `hiss-native`: toast + AUMID + window icon) | **HITL** | #206 |
| [#208] | Board render (NEEDS YOU / RUNNING / DONE) + click-through | AFK | #205, #206 |
| [#209] | Daemon liveness display (alive / stale / dead badge) | AFK | #206 |
| [#210] | Daemon supervision controls (start / stop / restart) | AFK | #209 |
| [#211] | Tray-resident app + NEEDS YOU count badge | AFK | #205, #206 |
| [#212] | OS notification on newly-arrived NEEDS YOU (set-diff) | AFK | #207, #211 |
| [#213] | Slice-detail trust view — verdict / findings + PR *(incl. verdict-machine-readability investigation)* | AFK | #205, #206 |
| [#214] | Slice-detail trust view — model / cost / duration + transcript link | AFK | #213 |
| [#215] | **Acceptance** — board verified in situ via `electrobun-dev` | HITL (`review:human`) | all of the above |

[#205]: https://github.com/CaribouJohn/pi-flow/issues/205
[#206]: https://github.com/CaribouJohn/pi-flow/issues/206
[#207]: https://github.com/CaribouJohn/pi-flow/issues/207
[#208]: https://github.com/CaribouJohn/pi-flow/issues/208
[#209]: https://github.com/CaribouJohn/pi-flow/issues/209
[#210]: https://github.com/CaribouJohn/pi-flow/issues/210
[#211]: https://github.com/CaribouJohn/pi-flow/issues/211
[#212]: https://github.com/CaribouJohn/pi-flow/issues/212
[#213]: https://github.com/CaribouJohn/pi-flow/issues/213
[#214]: https://github.com/CaribouJohn/pi-flow/issues/214
[#215]: https://github.com/CaribouJohn/pi-flow/issues/215

**Roots** #205 + #206 unblock everything. The two **HITL** leaves (#206 scaffold, #207
native) are the human-bootstrap of the GUI stack; agents build the rest. So this track is
**not fully AFK** — the human stands up the shell + native DLL (the parts invisible to a
headless verify), then the autonomous loop takes over.

## 8. Risks / watch-items

- **Reviewer-verdict machine-readability** (S6) — the biggest unknown; surfaced as an explicit investigation rather than assumed.
- **WebView2 platform gaps** (§9) — OS notifications and tray APIs must be verified on WebView2, not assumed from Chrome.
- **Orphaned daemon child** (S4) — quitting the tray app must reliably stop or cleanly detach the supervised daemon; an orphaned headless daemon writing the same heartbeat would confuse liveness. The supervisor state machine owns this.
- **The board re-deriving state** — the standing temptation; reviewers should reject any board logic that recomputes lifecycle state instead of consuming `BoardSnapshot` (§2 anchor).

## 9. Doc reconciliation

- HARNESS-DESIGN decision #5 / CONTEXT.md say *"the dashboard talks to flowd over a local RPC seam."* **In v1 that seam is not built**: the only RPC seam is Mainview↔Bun (webview ↔ its own host); the board↔loop relationship is process supervision + shared state (heartbeat file, tracker/git). A flowd↔dashboard RPC seam reappears only if a later track splits flowd into a long-running *service* with a remote client. Recorded in **ADR-0039**; CONTEXT.md's `dashboard` entry refined.
- *"Closing it doesn't stop flowd"* is sharpened: **closing the window** (→ tray) doesn't; **quitting the app** stops the app-supervised daemon child (the daemon still runs standalone from a terminal).
