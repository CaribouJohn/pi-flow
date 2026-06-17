# Context — pi-flow

The glossary for this repo. Terms only — no implementation details, no specs.
This project **builds** the Flow Harness; it also **runs on** Flow to build itself.

## Glossary

- **Flow** — the delivery *lifecycle machine*: the roles, transitions, and invariants
  in `docs/SPEC.md` / `docs/transitions.yaml`. Repo-agnostic. Not a program.

- **Flow Harness** — the *product* that runs Flow unattended (an "AFK" — away-from-keyboard
  — app). Two collaborating parts: **flowd** + **the dashboard**. Designed in
  `docs/HARNESS-DESIGN.md`.

- **flowd** — the always-on background *service* (a Bun process) that executes the Flow
  tick loop: read tracker+git, derive state, run the next legal action, spawn agents.
  Holds no authoritative state of its own (state lives in the tracker + git).

- **dashboard** — the human-facing *client* (an Electrobun + React webview): a view over
  the same tracker+git source. It reuses the engine's derivation rather than re-deriving
  state. In its v1 shape (PRD-0002 / ADR-0039) the dashboard's Bun process is a
  **supervisor + viewer**: it supervises a `flowd daemon` child and reads the world via
  `flow-engine` directly; the only RPC seam is Mainview↔Bun (webview ↔ its own host), not a
  flowd↔dashboard seam. **Closing the window** (→ tray) doesn't stop flowd; **quitting the
  app** stops the app-supervised daemon (which still runs standalone from a terminal).

- **the `/flow` skill** — the *existing Claude Code skill* (`.claude/skills/flow/`) that
  drives Flow conversationally today. Distinct from **flowd** (the future automated
  service). The skill is the **bootstrap harness**: we build flowd by running Flow
  *through this skill*, since flowd does not exist yet.

- **profile** — the per-repo parameterization Flow refuses to hard-code (tracker, label
  strings, verify command, branch model, reviewer invocation, merge authority). This
  repo's is `.pi/flow.profile.md`.

- **Pi** — the multi-LLM engine (`@earendil-works/pi`) flowd uses to spawn role agents
  (grill, slice, plan-review, implement, review). One Pi session = one fresh context.

- **role agent** — a Pi session playing one Flow role. The load-bearing constraint:
  the **review** agent is never the **implement** agent, and runs on a *different model*.
  Both the implementer and the reviewer are **`pi-coding-agent` `createAgentSession`**
  sessions; the implementer has write/git tools, the reviewer is read-only (it explores
  the code, not just the diff) and emits its verdict through a `submit_verdict` tool.

- **reuse-from-Hiss** — pi-flow ports proven patterns from the sibling Hiss repo rather
  than rebuilding them: the credential store (per-call key, presence-only reporting),
  the settings manifest, env-key scrubbing, and the framework-free `AIClient`/engine
  seam discipline (ADR-0016). The *coding-agent* layer (`pi-coding-agent`) is new here —
  Hiss deliberately used only `pi-ai` completions (its ADR-0029), no tools, no sessions.

- **flow-bot** — the distinct *principal* (identity) all autonomous Flow actions run as,
  separate from the maintainer. Its purpose is attribution and being the identity that
  branch protection excludes from `main` (ADR-0038) — not a magic permission scope.

- **Item / Track / Slice** — the units of work (see `docs/SPEC.md §1`): an Item is one
  tracker issue; a Track is a parent + its child Slices + one acceptance Item; a Slice
  is a leaf that branches off the track branch and merges back into it.

- **PRD** — a design artifact produced by a grill. In this project a PRD is the *input
  to a Track*: it lands an Item in `needs-slicing`, which auto-slices into a Track. The
  "starting PRDs" are the first Tracks we will build flowd through.

- **walking skeleton** — the first PRD's deliverable: the thinnest end-to-end path that
  exercises the riskiest architecture (Pi driving one autonomous Slice), with everything
  else deferred.
