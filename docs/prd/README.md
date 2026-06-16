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
| 0004 | Acceptance + identity + cost | Back bookend (A1–A3): staged track→`main` PR + in-app **Accept & merge** (your creds). **`flow-bot` principal + branch protection + keychain** (ADR-0038). Cost **meter** (actual vs estimate). | **ready to slice** ([#105](https://github.com/CaribouJohn/pi-flow/issues/105), [PRD](./0004-back-bookend-headless.md)) — grilled 2026-06-16; headless back bookend (`flowd accept`/`reject` + cost meter + `flow-bot` bot-PAT), in-app accept deferred to 0002 |
| 0005 | Continuous daemon | Wrap the one-shot loop in the always-on **tick/poll-cadence daemon** + tray lifecycle (AFK: window closed ≠ work stops). Concurrency via worktrees; the assignee claim is the lock. | needs-grilling ([#106](https://github.com/CaribouJohn/pi-flow/issues/106)) |

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
