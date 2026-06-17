# ADR-0039: Dashboard topology — supervisor + independent viewer, no flowd↔dashboard RPC seam in v1

## Status

Accepted — refines HARNESS-DESIGN §2.1 and decision #5, and the CONTEXT.md `dashboard`
entry, which describe the dashboard as a thin client that "talks to flowd over a local RPC
seam." Grilled into [PRD-0002](../prd/0002-read-only-board.md) (2026-06-17).

## Context

HARNESS-DESIGN §2.1 offered two topologies for the dashboard: a **recommended v1** where one
tray-resident Electrobun app's Bun process *runs the flowd loop in-process*, and an **escape
hatch** where flowd is a headless daemon and the dashboard is a separate client over a local
RPC seam. Decision #5 and the glossary committed to "the dashboard is a thin client; it talks
to flowd over a local RPC seam; closing it does not stop flowd."

Two things changed between that design grill and PRD-0002:

1. **PRD-0005 already took the escape hatch.** The loop now ships as a standalone, headless
   `flowd daemon`, observable via a heartbeat file and `flowd status` — there is no
   long-running flowd *service* exposing an RPC interface.
2. **The engine derives the board.** `flow-engine` (the `World` reducer + `classifyNeedsYou`,
   SPEC §8.5) already computes exactly NEEDS YOU / RUNNING / DONE; `runStatus` proves the
   read path. SPEC §0 forbids a second derivation of lifecycle state.

So the v1 board faces three structural choices the original framing had pre-answered:
*where does the loop run*, *how does the webview get the world*, and *is there a
flowd↔dashboard RPC seam at all*.

## Decision

1. **Supervisor + viewer, not pure-viewer and not in-process loop.** The tray app's Bun
   process **spawns `flowd daemon` (unchanged) as a supervised child** — start on launch,
   start/stop/restart controls, liveness from the child's heartbeat + exit code. It does
   *not* run the loop in-process, and it is *not* a pure viewer that leaves the operator to
   start the daemon separately.

   - *Rejected — in-process loop* (§2.1's literal recommendation): a WebView2/Electrobun host
     crash would take the autonomous loop down with it — the exact AFK-persistence hazard
     §2.1 itself flagged — and the loop could not run without the GUI.
   - *Rejected — pure viewer*: honest read-only, but it abandons the product shape
     (decision #5: *UI closed ≠ work stops*) and makes the operator launch and babysit two
     things forever.

2. **The viewer reads `flow-engine` directly; it is an independent second reader of the
   world.** The Bun process imports the engine's read path (the `BoardSnapshot` builder
   refactored out of `runStatus`) and serves it to the webview over the **Mainview↔Bun** RPC
   seam (Hiss / ADR-0016). It does **not** consume a snapshot the daemon writes, and it does
   **not** re-derive state from the tracker.

   - *Rejected — daemon-written snapshot file*: stale when the daemon is idle or stopped —
     precisely when an AFK board still needs to show the truth.
   - *Rejected — board re-derives from the tracker*: a second reducer that drifts from the
     engine (violates SPEC §0).

   The daemon child and the viewer therefore both read tracker+git through the same engine
   functions, on independent cadences. They never disagree about *what the world means*.

3. **There is no flowd↔dashboard RPC seam in v1.** The only RPC seam is Mainview↔Bun (the
   webview talking to its own host). The board↔loop relationship is **process supervision +
   shared state** (the heartbeat file; tracker+git). A flowd↔dashboard RPC seam reappears
   only if a future track splits flowd into a long-running *service* with a remote client —
   which the framework-free engine (ADR-0016) keeps a pure binding change.

## Consequences

- "Closing it does not stop flowd" is sharpened: **closing the window** (→ tray) does not;
  **quitting the app** stops the app-supervised daemon child. The daemon remains
  independently runnable from a terminal, so "stop the GUI" and "stop the work" are
  separable.
- The supervisor owns **child-lifecycle hygiene** (orphan handling on quit/crash); an
  orphaned daemon writing the same heartbeat would corrupt liveness. This is a named risk in
  PRD-0002 §8.
- HARNESS-DESIGN §2.1/#5 and the CONTEXT.md `dashboard` entry are reworded: v1 is a
  supervisor+viewer reading the engine directly, not a thin RPC client of a flowd service.
- The decision is **scoped to v1 and reversible by addition**: going multi-process (a real
  flowd service + remote dashboard) or multi-repo later does not invalidate this — it adds
  the RPC seam that v1 deliberately omits. Recorded here so the "why is the read-only board
  spawning the daemon, and where's the RPC seam the docs promised?" question isn't
  re-litigated.
