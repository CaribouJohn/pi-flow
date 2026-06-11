---
name: electrobun-dev
description: Debug the running Electrobun (Hiss) desktop app directly — inspect and drive the REAL webview UI in situ against a live session via Chrome DevTools Protocol. Use when chasing a UI/runtime bug in the real app, verifying a fix in situ, reproducing a real-Bun/real-SDK/real-WebView2 error, capturing the app's console/exceptions, or when the standalone mock can't reproduce something. Triggers: "debug the app", "inspect the running app", "what's the app's console saying", "reproduce/verify it in the real app".
---

# Electrobun dev — debug the real app in situ

This skill attaches to the **real running app's webview** over the Chrome
DevTools Protocol so the agent can *see real console/exceptions, read real state,
and drive the real UI* — instead of blind-looping on guesses. It is the project's
UI debug loop: it reproduces the **real-Bun / real-SDK / real-WebView2** bug class
that actually costs us (e.g. an SDK method throwing, an Electrobun `blob:views://`
URL 404ing). (It superseded the old standalone Mainview + MockBun harness — see
ADR-0025.)

**The core value is information quality.** When stuck, the first move is almost
always `logs` (webview console/exceptions) + the dev-process output (Bun/native).
Most wasted loops came from fixing without that.

## Config (the only Hiss-specific bits — isolated for later extraction)

| What | Value |
| --- | --- |
| Launch command | `bun run --filter hiss-desktop dev:debug` (pre-cleans any prior instance, sets the debug-port env var, then `electrobun dev`) |
| Stop command | `bun run --filter hiss-desktop stop:debug` (graceful WM_CLOSE = clicking ✕; cascades the whole tree + the launch task down, frees the port) |
| Debug port | `9222` (override the helper with `CDP_PORT`) |
| Webview target | the single `page` target, `views://mainview/index.html` |
| Dev-process log | the background task's output file (Bun-side / launcher / native logs, incl. startup) |
| Platform | **Windows / WebView2 only** for now (the `--remote-debugging-port` lever is a WebView2 env var). macOS/WKWebView is a separate mechanism — add later. |

## How it works

WebView2 exposes a CDP endpoint on `:9222` when the app is launched with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` (that's all
`dev:debug` does). `cdp.ts` is a self-contained Bun WebSocket→CDP client — no
Playwright, no extension. `claude-in-chrome` tools do **not** work here (they only
see Chrome extension instances, not a raw WebView2 endpoint).

## Workflow

1. **Ensure the app is running with the debug port.** Check `http://127.0.0.1:9222/json`.
   If absent, launch `bun run --filter hiss-desktop dev:debug` (background) and wait
   for the endpoint. A code change needs a **rebuild** (no HMR): re-run `dev:debug`,
   or `reload` only picks up already-built assets.
2. **Login is the human's job.** The app resumes `~/.hiss/session.json`, so usually
   you land in a live session with no login. If `snapshot` shows the login screen,
   **ask the user to log in** — never enter credentials yourself.
3. **Inspect first, always.** `logs` and `snapshot`/`screenshot` before theorising.
   For Bun-side / native / startup errors (which fire before the webview is
   attachable), read the **dev-process output** — that's where a startup crash prints.
4. **Drive to reproduce / verify** with `click` / `type` — under the guardrails below.
5. **Fix → rebuild (`dev:debug`) → re-inspect.** Iterate on real evidence.
6. **Shut down cleanly with `stop:debug`** — see below.

## Shutting down — always `stop:debug`, never a bare kill

Electrobun's `launcher → bun → WebView2` is a **detached process tree**. `TaskStop`
on the launch task (or killing `electrobun dev`) leaves `bun` + `msedgewebview2`
**orphaned, holding `:9222`** — which **segfaults the next launch**. So:

- **To stop, run `bun run --filter hiss-desktop stop:debug`.** It sends `WM_CLOSE`
  to the app window (the graceful "click the ✕" path) so Electrobun tears the whole
  tree down; the launch background task then ends on its own and the port frees. A
  force-kill + port-free fallback covers the rare case the window won't close.
- **`dev:debug` also pre-cleans** on launch, so a previously-orphaned instance can't
  crash the new one — but prefer `stop:debug` for teardown so it never gets there.
- Don't rely on `TaskStop` alone for the app; use it only if `stop:debug` is somehow
  unavailable, and then run `stop:debug` to clean up the orphans.

## Commands

Run via `bun .claude/skills/electrobun-dev/cdp.ts <command>`:

| Command | Does |
| --- | --- |
| `screenshot [path]` | capture the webview to a PNG (Read the file to view it) |
| `eval <js>` | run JS in the webview, return the JSON result (read state, invoke methods, set values) |
| `snapshot` | inventory interactive elements (buttons/links/inputs by role/label) + title/url/text |
| `logs [seconds]` | install an idempotent in-page console/error buffer + dump it; with `seconds`, also stream live console/exceptions while you reproduce |
| `click <cssSelector>` | click the first match |
| `type <sel> <text>` | set an input's value + fire input/change (refuses password fields) |
| `reload` | reload the webview (after a rebuild) |
| `capture` | trigger `/hiss-capture`, return the new capture file path (see "State capture") |

`eval` is the swiss-army — it can read anything and invoke `.click()`/set values
on any element. The named commands are conveniences over it.

## State capture (`/hiss-capture`)

For state-shape bugs (wrong `AppState`, a reconcile/echo glitch, a missing field),
a screenshot or one-off `eval` isn't enough — you want the **whole reconciled
`AppState` at that exact moment**. `/hiss-capture` is a *local* mechanical command
(it posts **nothing** to the channel) that dumps the full state to
`~/.hiss/captures/state-<ISO>.ts`.

- **`capture`** drives it for you (sets `/hiss-capture` in the composer + submits)
  and returns the new file path. It needs a **composer in view** — open a channel
  first; if none is open it errors and tells you. You can also ask the user to hit
  `/hiss-capture` at the moment a bug shows, then read the file.
- **Then `Read` the returned `.ts` file** — it's a self-contained dump of the exact
  `AppState` (auth, user, servers, memberships, inbox, presence, …), readable as a
  plain state snapshot for diagnosing state-shape bugs.
- **PII caveat:** captures contain **real user data** (usernames, message content,
  ids, avatar URLs). Read them to debug, but **never commit one** or paste it
  wholesale — sanitise first (see `docs/contributing/privacy.md`). The captures dir
  lives outside the repo.

## Guardrails — this drives a REAL account

The webview is a live session: real Servers, real DMs, real people. Treat every
mutation as consequential.

- **Never** enter credentials or `type` into a password field (the helper also refuses).
- **Inspect freely** (`screenshot`/`eval`/`snapshot`/`logs` are read-only and safe).
- **Confirm in chat before any side-effectful or irreversible action** — sending a
  message, submitting a form, deleting, leaving a Server, changing account settings.
  A stray `click` can DM a real person. When in doubt, screenshot + ask.
- Don't exfiltrate session content beyond what's needed to debug; this is the user's
  real data (see `docs/contributing/privacy.md`).

## Status

This is the project's UI debug loop. The standalone Mainview + MockBun it replaced
have been **retired** (ADR-0025). The component tests (`*.test.tsx`) and the shared
`ChatBackend` core stay regardless.
