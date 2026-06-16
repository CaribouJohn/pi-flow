# PRDs — the Flow Harness build roadmap

Each PRD is the design artifact for **one feature track**: it lands an issue in
`needs-slicing`, gets decomposed by `/to-issues` into agent-ready slices, and runs through
the Flow lifecycle (eventually through `flowd` itself, once it exists). PRDs are grilled
one at a time, when their turn comes — only PRD-0001 is fully specified today.

Design source of truth: [`../SPEC.md`](../SPEC.md) (the machine),
[`../HARNESS-DESIGN.md`](../HARNESS-DESIGN.md) (the product), [`../adr/`](../adr/).

## Sequencing principle

Build the **scariest novel thing first, thin and end-to-end**; defer anything with
precedent (Electrobun/CDP from Hiss; `pi-ai`/creds/settings from Hiss). De-risk the
engine before the pixels.

## The roadmap

Each track is a tracker issue in `needs-grilling` — the future primary input channel.
Grilling order is a maintainer choice (not the table order): PRD-0003 is grilled first to
de-risk the engine before the pixels.

| PRD | Track | Delivers | Status |
| --- | --- | --- | --- |
| **0001** | **Headless walking skeleton** | `flowd run --track <n>` drives one autonomous slice **S0–S8** (claim → `pi-coding-agent` implement → verify → PR → different-model review → merge to track branch → close) against a **sandbox** fixture. One-shot, headless. | **shipped** ([#79](https://github.com/CaribouJohn/pi-flow/issues/79) → [#102](https://github.com/CaribouJohn/pi-flow/pull/102)) |
| 0002 | Read-only board | Electrobun tray app + React webview: `NEEDS YOU / RUNNING / DONE` over tracker+git, click-through to the real ticket. Reuses the Hiss shell + RPC seam. Read-only. | needs-grilling ([#103](https://github.com/CaribouJohn/pi-flow/issues/103)) |
| 0003 | Front bookend (headless) | **auto-slice** (T12) → **agent plan-gate** (T13/T14) + cost **estimate**, driven from the CLI over an existing PRD. The interactive grill *chat* is deferred to a later UI track (engine before pixels). | **shipped** ([#104](https://github.com/CaribouJohn/pi-flow/issues/104) → [#123](https://github.com/CaribouJohn/pi-flow/pull/123), [PRD](./0003-front-bookend-headless.md)) — first track built by flowd-on-flowd |
| **0004** | **Acceptance + identity + cost (headless)** | Back bookend (A1–A3): `flowd accept` stages the track→`main` PR with a deterministic summary (never merges); `flowd reject` files a `needs-triage` corrective. **`flow-bot` principal** (bot-account PAT) + branch-protection enforcement (ADR-0038). Cost **meter** (actual vs estimate, `flowd calibrate`). | **shipped** ([#105](https://github.com/CaribouJohn/pi-flow/issues/105) → [#154](https://github.com/CaribouJohn/pi-flow/pull/154), [PRD](./0004-back-bookend-headless.md)) — headless back bookend; built flowd-on-flowd, accepted via its own `flowd accept` under a genuinely-enforced merge boundary. In-app **Accept & merge** + keychain deferred to PRD-0002. |
| 0005 | Continuous daemon (headless) | Wrap the one-shot verbs in an always-on **`flowd daemon`** + **`flowd status`**: fixed-cadence tick drives the full §8.2 pipeline over all tracks to a fixpoint, **single-threaded**, with a logs+heartbeat+status **trust surface** and classified transient/fatal failure handling. **Worktree concurrency, the tray binding, and native notifications are deferred** (engine-before-pixels; the tray app owns AFK lifecycle later). | **shipped** ([#106](https://github.com/CaribouJohn/pi-flow/issues/106) → [#194](https://github.com/CaribouJohn/pi-flow/pull/194), [PRD](./0005-continuous-daemon.md)) — built flowd-on-flowd; live-acceptance caught a `track/<id>` branch-resolution bug, repaired via correctives (#190/#191) |

Later / deferred (HARNESS-DESIGN §10): hard cost caps, daemon/dashboard process split,
additional tracker adapters (Azure DevOps, …), in-situ CDP verification for UI slices,
the escalation smell-set and the effort→model map firming up with use.

## Dogfooding note

PRD-0001's **build work lives in this repo (`pi-flow`)** — that's where `flowd`'s code is
written, driven by the existing Claude Code `/flow` skill (the bootstrap harness). The
**sandbox repo is only `flowd`'s runtime fixture** — the thing the skeleton operates on,
not where we write code. Once `flowd` can drive the sandbox, the same engine is pointed at
`pi-flow`'s own tracker (a profile change, not new code) and the project starts building
itself.
