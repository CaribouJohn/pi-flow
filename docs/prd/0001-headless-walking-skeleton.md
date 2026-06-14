# PRD-0001 — flowd headless walking skeleton (S0–S8 over a sandbox)

**Status:** ready to slice (grilled 2026-06-14, `/grill-with-docs`)
**Parent design:** [SPEC.md](../SPEC.md) · [HARNESS-DESIGN.md](../HARNESS-DESIGN.md) · ADR-0038
**Lifecycle role:** this PRD is the design artifact for the **first feature track** of
the Flow Harness. It lands an issue in `needs-slicing` → `/to-issues` → a `tracking`
parent built by the existing Claude Code `/flow` skill (the bootstrap harness; flowd does
not exist yet).

---

## 1. Why this first

The Flow Harness product is large (engine, 5 role agents, model routing, cost meter,
git/forge identity, in-situ CDP, Electrobun tray app, RPC seam, the board, accept&merge).
We build the **scariest novel thing first, end-to-end and thin**, and defer everything
that already has precedent.

What is *de-risked* (we reuse, don't reinvent): the Electrobun shell, the RPC seam, CDP,
and — newly confirmed by researching the sibling **Hiss** repo — the entire `pi-ai`
completion layer, the credential store, the settings manifest, and the framework-free
`AIClient` seam (ADR-0016).

What is *unproven here* and therefore the target of this PRD: **`pi-coding-agent` driving
the autonomous per-slice loop** — a coding-agent session that writes code to a worktree
with custom tools, a *second* session on a *different model* that reviews it, and the
deterministic orchestrator that claims → implements → verifies → reviews → merges. Hiss
deliberately never built the coding-agent layer (its ADR-0029), so this is the genuine
new ground.

## 2. The one outcome (definition of done)

A single command —

```
flowd run --track <n>
```

— against a **dedicated sandbox repo** that has a pre-cleared `tracking` parent with one
planted `ready-for-agent` slice ("add `add(a,b)` + a passing test"), drives that slice all
the way to **merged into the track branch and closed**, fully unattended, and then exits
at the fixpoint. Concretely, after one invocation, against the sandbox:

1. the track branch was drift-refreshed from `main` (S0);
2. the slice issue was claimed via **assignee** (S1);
3. a `pi-coding-agent` **implementer** session wrote the code on a slice branch off the
   track branch (S2);
4. the **verify gate** ran green (S3);
5. a PR was opened with **base = the track branch** (S5);
6. a *second* `pi-coding-agent` **reviewer** session **on a different model** investigated
   the change and returned `APPROVE` via a `submit_verdict` tool (S6);
7. the orchestrator **merged the slice PR into the track branch**, deleted the slice
   branch, and **closed the slice issue** (S7);
8. the loop found no further assignable slice and exited (S8).

Re-running the command is a **no-op** (idempotent; SPEC §8.8) — the slice is already
closed.

A REQUEST_CHANGES verdict instead loops back to S2 with the review attached, **bounded**
to `reviewer_iteration_cap` (profile = 2); on exhaustion the run stops and reports
(never a silent loop).

## 3. Non-goals (explicitly deferred to later PRDs)

- **Front bookend** — triage, grill chat, auto-slice (T12), plan-gate (T13/T14). For this
  PRD the track + slices + plan clearance are **set up by hand / the existing `/flow`
  skill** on the sandbox. flowd is *entered mid-lifecycle* at a `tracking` parent
  (SPEC §7: every state is an entry point).
- **Back bookend** — acceptance (A1–A3) and any `main` merge. flowd merges **only** into
  the track branch here.
- **`flow-bot` identity, scoped tokens, keychain, branch protection** — PRD #1 uses
  ordinary `gh`/PAT auth from the environment and relies on defence-in-depth (no
  main-merge code exists). Structural enforcement lands with the acceptance PRD (ADR-0038).
- **In-situ / CDP** (S4) — no UI in the sandbox.
- **Concurrency / worktrees** — single track, single slice, single-threaded.
- **The continuous daemon / poll cadence / tray** — PRD #1 is a one-shot drive-to-fixpoint
  CLI. The daemon is a later PRD that *wraps* this exact loop.
- **The dashboard, cost meter/estimator** — later PRDs.
- **Full per-role × effort model routing** — PRD #1 uses a minimal role→model config (two
  distinct models); the routing table firms up later.

## 4. Shape & architecture

- **Bun + TypeScript.** Engine kept **framework-free** from day one (ADR-0016) so the
  later dashboard/daemon binds to it without a rewrite. Suggested layout:
  - `packages/flow-engine/` — the framework-free reducer + role-agent drivers + adapter
    interfaces. No CLI, no UI imports. Unit-testable with fakes.
  - `packages/flowd-cli/` — the thin one-shot binding (`flowd run --track <n>`) that wires
    real adapters into the engine.
- **Stateless reducer over (tracker + git)** (SPEC §0/§8.2). The one-shot loop:
  `read world → derive states → if assignable: advance one step → repeat; else exit`.
  No internal state machine — the tracker is the state machine. Every step idempotent or
  guarded (SPEC §8.8).
- **Profile-driven** (SPEC §6) — reads `.pi/flow.profile.md` (already scaffolded) for the
  tracker, label map, branch model, verify gate, reviewer cap, AI disclaimer. The sandbox
  target is selected by a profile/flag, not hard-coded.

## 5. Reuse from Hiss (port, don't rebuild)

Confirmed reusable patterns (`C:\development\AI\hiss`):

| Capability | Hiss source | How to reuse |
| --- | --- | --- |
| Credential store | `hiss-core/src/credential-store.ts` (`FileCredentialStore`) | Port: per-call key, presence-only, 0600 file. Feeds `authStorage.setRuntimeApiKey()`. |
| Settings manifest | `hiss-core/src/settings.ts` (`defineSettings`, `HISS_SETTINGS`) | Port the shape for flowd config (role→model map, profile path). |
| Env-key scrub | `hiss-desktop/src/bun/index.ts:66–76` | Port: neutralize ambient provider env keys; pass keys per call only. |
| Framework-free AI seam | `hiss-core/src/ai-client.ts` + `hiss-desktop/src/bun/ai-client-pi.ts` | Mirror the seam discipline (types in core, impl Bun-side, injectable fake). |
| Usage/cost accounting | Pi `AssistantMessage.usage` mapping | Reuse for the (later) cost meter; capture per-session usage now even if unmetered. |

New here (no Hiss precedent): `pi-coding-agent` sessions + custom tools.

## 6. Pi integration (the new ground)

Both role agents are **`pi-coding-agent` `createAgentSession`** sessions (uniform engine):

```ts
import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
```

- **Implementer** — `createAgentSession({ model: getModel(impl.provider, impl.id), customTools, authStorage, modelRegistry })`, run in the slice worktree. Gets write/file/shell tools (built-in) plus custom `defineTool`s the orchestrator needs (e.g. a scoped `run_verify_gate`). Self-contained brief from the slice issue.
- **Reviewer** — a *second* session **on a different model** (enforced by the orchestrator — see §7), **read-only** (no write/git-mutate tools), free to *investigate the code*, not just the diff. It returns its verdict through a custom tool so output is structured, not parsed from prose:

```ts
const submitVerdict = defineTool({
  name: "submit_verdict", label: "Submit review verdict",
  description: "Record the final review decision.",
  parameters: Type.Object({
    decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES")]),
    findings: Type.Array(Type.String()),
  }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: "recorded" }], details: p }),
});
```

- **Keys:** `authStorage.setRuntimeApiKey(provider, key)` from the ported credential store
  (not persisted, not from ambient env — Hiss's pattern).

## 7. Invariants this PRD must honour (SPEC §9)

- **Reviewer ≠ implementer, different context *and* different model** — enforced
  *structurally* in the orchestrator: distinct sessions, and a guard that **refuses to run
  the reviewer on the implementer's model** (fail loudly if config sets them equal).
- **Never merge past a red gate** — merge requires verify-green **and** `APPROVE`.
- **Slices merge into the track branch, never `main`** — base of every PR is the track
  branch; no main-merge code path exists.
- **Claim before work** — set the assignee (S1) before implementing; the only lock.
- **Every tracker write carries the AI-disclaimer prefix** (profile value).
- **Respect dependencies** — only pick a slice with no open `Depends on:`.

## 8. The sandbox fixture (a setup artifact, not flowd code)

A dedicated throwaway repo (e.g. `CaribouJohn/pi-flow-sandbox`) seeded once with:
- `main` with a trivial project + a passing trivial verify command;
- a `tracking` parent issue and a `track/<slug>` branch off `main`;
- one `ready-for-agent` child slice: *"add `add(a, b)` returning `a+b`, with a unit test"*,
  with a self-contained brief and a named verification method (the verify command).

Correct output is obvious; a wrong merge harms nothing. A `scripts/seed-sandbox` helper
should make this reproducible (so the skeleton's pass/fail is deterministic across runs).

## 9. Proposed slices (the `/to-issues` decomposition will finalize)

Vertical, each independently verifiable. Ordered by dependency:

1. **Engine skeleton + fakes** — the framework-free reducer, adapter *interfaces*
   (tracker/git/agent), derived-state computation, and the one-shot loop driven entirely
   by **in-memory fakes**. Verifiable by unit tests; no network.
2. **Tracker adapter (GitHub via `gh`)** — list/get/label/assign/comment/close + parse the
   dependency section. Verified against the sandbox repo (read + a no-op write round-trip).
3. **Git/forge ops** — branch off track, commit, push, open PR (base=track), merge into
   track, delete branch, read PR status. Verified by driving the sandbox by hand.
4. **Pi implementer session** — `createAgentSession` writes the planted slice's code in a
   worktree and greens the verify gate. Verified: the sandbox slice gets a correct diff.
5. **Pi reviewer session (different model) + `submit_verdict`** — read-only session returns
   a parseable verdict; orchestrator enforces reviewer≠implementer model. Verified: a
   correct change → APPROVE; a deliberately broken change → REQUEST_CHANGES.
6. **Orchestrator wiring S0–S8 end-to-end** — compose 1–5 into `flowd run --track <n>`;
   the full §2 outcome passes against the sandbox; re-run is a no-op.
7. **Credential store + config port from Hiss** — `FileCredentialStore`, env-scrub, the
   role→model config; two-model run works from stored keys.

(Slice 1 is also the natural place to confirm the SDK shape against our assumptions — if
`pi-coding-agent` differs from §6, it surfaces before the loop is built around it.)

## 10. Open questions / risks (carry into slicing)

- **Two models, one or two providers?** Minimum bar for the invariant is two **different
  model ids**; the stronger "independent blind spots" form is two **different providers**
  (two API keys). Recommend: config allows either; default to two distinct models, prefer
  cross-provider for real tracks. Decide at slice 5/7.
- **Reviewer scope of tools** — read-only file/search tools only; confirm `pi-coding-agent`
  lets us *omit* the write/mutate tools cleanly (not just instruct against them).
- **`gh` as the git/forge surface vs an API client** — `gh` matches the profile and is
  simplest; revisit if multi-repo/App identity (later PRD) needs the API.
- **Verify gate in the sandbox** — keep trivial and fast; the real pi-flow verify gate is a
  later concern (the profile currently has a default-pass placeholder).
