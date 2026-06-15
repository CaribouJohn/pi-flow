# RUNBOOK — first live `flowd run` (the walking skeleton)

This drives the **headless walking skeleton** (track #79) end-to-end against the
**sandbox** fixture, with real models. The engine, adapters, and Pi wiring are
built and unit-tested; this is the first run with live LLMs, so it's the step
that verifies the deferred acceptance criteria of #86/#87/#88.

> You run this (it needs your API keys and incurs real spend). Per the agreed
> "I prep, you run" split.

## 1. Prerequisites

- **Bun** ≥ 1.3, **`gh`** authenticated (`gh auth status`), and **`sh`** on PATH
  (ships with Git for Windows, which `gh` already implies) — the verify gate runs
  via `sh -c`.
- **Two provider API keys** — one for the implementer model, one for a
  *different* reviewer model (invariant #2). The example config uses
  `anthropic/claude-opus-4-8` (implement) + `openai/gpt-5` (review) — change the
  review model to whatever provider you have a key for.
- The sandbox repo seeded (step 2).

## 2. Seed the sandbox (idempotent)

```sh
bun scripts/seed-sandbox.ts
```

This (re)creates `CaribouJohn/pi-flow-sandbox` with a `tracking` parent (#1), the
`track/sandbox-demo` branch, and one `ready-for-agent` slice (#2: "add add(a,b) +
test"). Re-running is a no-op.

## 3. Provide API keys (credential store)

flowd reads keys from a credential-store JSON (never the ambient env). Create the
file referenced by `credentialsPath` (default `.flowd/credentials.json`):

```json
{
  "schemaVersion": 1,
  "keys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-..."
  }
}
```

Use the provider names that match your `models` config. The file is 0600 on
POSIX and is git-ignored; it must never be committed.

## 4. Configure flowd

```sh
cp flowd.config.example.json flowd.config.json
```

Edit `flowd.config.json`: set `models.review` to your chosen *different* model,
confirm `repo`/`trackBranch`, and `actor` (the assignee/attribution identity).
`flowd.config.json` and `.flowd-workdir/` are git-ignored.

## 5. Run

```sh
bun packages/flowd-cli/src/index.ts run --track 1 --config flowd.config.json
```

(The config path resolves as `--config` flag → `FLOWD_CONFIG` env var →
`flowd.config.json` default.)

`--track 1` is the **tracking parent** id (its `ready-for-agent` children are the
slices). flowd will: clone the repo into `.flowd-workdir`, **S0** drift-refresh,
**S1** claim slice #2, **S2** implement with the implement model, **S3** verify
(`bun run verify` in the workdir), **S5** open a PR based on `track/sandbox-demo`,
**S6** review with the *different* model (verdict via `submit_verdict`), **S7**
merge into the track branch and close #2, then exit at the fixpoint.

### Expected output (happy path)

```
  drift-refresh #1 — ...
  claim #2 — assignee=...
  implement #2 — PR #N opened (base=track/sandbox-demo)
  review #2 — review: APPROVE
  merge #2 — merged PR #N; closed slice
outcome: fixpoint
```

`main` of the sandbox is untouched; `track/sandbox-demo` has the merged change.

## 6. Verify the harder paths

- **Bounded changes loop:** break the planted slice's expectation (e.g. edit #2's
  brief to demand something the reviewer will reject), re-run, and confirm it
  loops at most `reviewerIterationCap` reviews then `outcome: parked`.
- **Idempotency:** run step 5 again after a green run — it should reach
  `outcome: fixpoint` immediately with no claim/implement/merge steps (slice #2
  is closed).

## 7. Pointing at a real repo (later)

Change `repo`/`trackBranch`/`models` in the config. For any non-sandbox repo,
first configure **branch protection on `main`** excluding the autonomous identity
(ADR-0038) — flowd never merges `main`, but branch protection is the structural
guarantee, not the code.

## Report back

Capture the run output (and any error). If the SDK shape differs from the wiring
(e.g. `createAgentSession`/`session.prompt`/`submit_verdict` behaviour), that's
the expected place for surprises — paste the error and we adjust the adapters.
