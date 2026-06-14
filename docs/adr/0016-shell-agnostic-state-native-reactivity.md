# Shell-agnostic state lives in framework-free modules, bound by native Shell reactivity

**Status:** proposed (tenet generalised from ADR-0014 and ADR-0015 during the 2026-06-02 architecture review)

Two features converged on the same shape — the optimistic-message reconciler (ADR-0014) and reply resolution (ADR-0015) — so we record the shape as a **tenet** for cross-shell features rather than rediscovering it each time.

**The tenet.** Shell-agnostic logic lives in a **framework-free module**. Each **Shell** (the Mainview/React Shell today, the planned TUI Shell) binds to it through its **own native reactivity primitive** — never a shared bespoke reactive runtime. The module returns **decisions, not platform callbacks** (e.g. an activation *kind*, not a `jumpToMessage` function), so nothing platform-specific crosses the seam.

**Two shapes, chosen by one test — does the module own asynchrony the Shell isn't already subscribed to?**

- **Pure reducer** `(state, event) → state'` — when every state transition is driven by events the Shell already receives. Example: the optimistic reconciler (ADR-0014) — echoes and confirmations ride the transport push-stream the Shell already subscribes to, so the Shell owns the reactive container and applies the reducer in its own `setState`. **Do not** add observability here; it would be machinery for no async.
- **Observable store** `feed(...)` / `subscribe(listener)` / `getSnapshot()` — when the module **self-initiates** async state changes nobody else is watching. Example: the reply resolver (ADR-0015) lazy-fetches off-window parents. It exposes a minimal observable waist; React binds via `useSyncExternalStore`, a TUI via a redraw subscription.

**Guardrail.** The shared waist stops at `subscribe`/`getSnapshot`. **Do not unify reactivity scheduling** — React and a TUI schedule re-renders completely differently, and abstracting that re-implements their internals (a seam with no real variation that earns it).

**Trade-off.** This is more discipline than "just use a React hook / Context": it keeps domain/UI logic framework-free and unit-testable, and unblocks the TUI Shell without a rewrite — at the cost of a thin per-Shell binding (~a line for `useSyncExternalStore`). We accept that cost because multi-Shell is a stated roadmap goal (`CONTEXT.md`, **Shell**).

**Consequences.** Reviews of a cross-shell feature check: (a) the logic is framework-free; (b) reducer-vs-store matches the asynchrony test; (c) no platform callbacks cross the seam — only decisions. A framework-free module may start in a Shell's `lib/` with one consumer and move to `hiss-core` when a second Shell consumes it.
