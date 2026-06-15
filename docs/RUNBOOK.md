# RUNBOOK — first live runs (walking skeleton + front bookend)

This drives the **headless walking skeleton** (track #79) AND the **front bookend**
(`flowd plan` → `flowd run`) end-to-end against the **sandbox** fixture, with real
models.

> You run this (it needs your API keys and incurs real spend). Per the agreed
> "I prep, you run" split.

## 1. Prerequisites

- **Bun** ≥ 1.3, **`gh`** authenticated (`gh auth status`), and **`sh`** on PATH
  (ships with Git for Windows, which `gh` already implies) — the verify gate runs
  via `sh -c`.
- **Four provider API keys** — one each for the implementer model, the reviewer
  model (invariant #2), the slicer model, and the plan-reviewer model
  (planReview ≠ slice, same invariant). The example config uses
  `anthropic/claude-opus-4-8` (implement + slice) + `openai/gpt-5` (review +
  planReview).
- **All models MUST support custom function-calling tools** — each role agent
  reports its verdict/tool-call via a `submit_*` tool. A model that can't (or
  won't) call custom tools always trips the fail-safe and the track parks.
  Verified working: `deepseek` (e.g. `deepseek-v4-flash`), `anthropic` Claude,
  native `openai`. Verified NOT working: `github-copilot/gpt-5-mini` (Copilot-
  proxied models don't expose custom tools). A known-good set: implement
  `deepseek/deepseek-v4-pro`, review `deepseek/deepseek-v4-flash`, slice
  `deepseek/deepseek-v4-pro`, planReview `deepseek/deepseek-v4-flash`.
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

## 6. `flowd plan` — the front bookend (PRD → plan → gate)

### 6a. Prepare a canned PRD

Create a local PRD file for a simple feature:

```sh
cat > /tmp/sandbox-prd.md << 'PRD'
# Sandbox Demo PRD

Build a simple CLI calculator that accepts two numbers and an operator
(+, -, *, /) and prints the result.

## Acceptance criteria
- [ ] CLI accepts `calc <a> <op> <b>` and prints the result
- [ ] Divides by zero gracefully (prints an error)
- [ ] Verify gate passes (`bun run verify`)
PRD
```

### 6b. Create a `needs-slicing` parent issue

Create an issue in the sandbox repo with the `needs-slicing` role label:

```sh
gh issue create \
  --repo CaribouJohn/pi-flow-sandbox \
  --title "PRD-0003 — front bookend demo" \
  --body "## Parent PRD\n\nSee the attached PRD document."
# Note the issue number (e.g. #3). Then label it:
gh issue edit 3 --repo CaribouJohn/pi-flow-sandbox --add-label needs-slicing
```

### 6c. Run `flowd plan`

```sh
bun packages/flowd-cli/src/index.ts plan \
  --issue 3 \
  --prd /tmp/sandbox-prd.md \
  --config flowd.config.json
```

This will:
1. Read the parent issue (#3, expected `needs-slicing`).
2. Read the PRD from `/tmp/sandbox-prd.md`.
3. Run the **slice agent** (Pi coding session on `models.slice`) — decomposes
   the PRD into child slice Items.
4. Run the deterministic **writer** (`writeSlicePlan`) — creates the child
   Items + acceptance Item via the tracker, advances parent →
   `needs-plan-review`.
5. Run the **plan-review gate** — the plan-reviewer agent (Pi session on
   `models.planReview`, a different model than the slicer) validates the plan,
   combined with the deterministic `effort:high` smell check.
6. On **clear**: advance parent → `tracking`, create the track branch, compute
   + post the cost estimate.
7. On **escalate**: leave parent in `needs-plan-review`, post the named risks.

**Idempotency:** re-running at any reached state is a no-op — the parent-role
 gate skips T12 when already past `needs-slicing`, per-child dedup prevents
 duplicate creation, and marker comments (`[slice-plan]`, `[plan-gate]`) make
 the gate a no-op when already cleared.

### Expected output (happy path)

```
parent: #3
slices: #4, #5
acceptance: #6
gate: clear
cost: ≈ $0.12, 2 slices
```

### 6d. Handoff smoke: run the first produced slice

After `flowd plan` clears the track, `flowd run` can claim the first slice:

```sh
bun packages/flowd-cli/src/index.ts run --track 3 --config flowd.config.json
```

This proves the **plan → run handoff**: the slice #4 (created by the plan)
has `Parent: #3` and role `ready-for-agent`, so `flowd run` discovers it,
claims it, and implements it through the full S0–S8 loop.

### 6e. Escalation smoke (injected `effort:high`)

To test the escalation path, manually edit one of the created child issues
to carry an `effort:high` label:

```sh
gh issue edit 4 --repo CaribouJohn/pi-flow-sandbox --add-label effort:high
```

Then re-run `flowd plan` — the parent should stay in `needs-plan-review`
with an escalation marker comment naming the `effort:high` risk.

## 7. Full-chain evidence (PRD → plan → run → fixpoint)

For the acceptance criterion requiring one full-chain capture:

```sh
# 1. Create the needs-slicing parent + PRD (steps 6a–6b above).
# 2. Plan it.
bun packages/flowd-cli/src/index.ts plan --issue N --prd /tmp/sandbox-prd.md --config flowd.config.json > plan-out.txt 2>&1
# 3. Run it.
bun packages/flowd-cli/src/index.ts run --track N --config flowd.config.json > run-out.txt 2>&1
# 4. Attach plan-out.txt + run-out.txt as evidence.
```

## 8. Verify the harder paths

- **Bounded changes loop:** break the planted slice's expectation (e.g. edit #2's
  brief to demand something the reviewer will reject), re-run, and confirm it
  loops at most `reviewerIterationCap` reviews then `outcome: parked`.
- **Idempotency:** run step 5 again after a green run — it should reach
  `outcome: fixpoint` immediately with no claim/implement/merge steps (slice #2
  is closed).

## 9. Pointing at a real repo (later)

Change `repo`/`trackBranch`/`models` in the config. For any non-sandbox repo,
first configure **branch protection on `main`** excluding the autonomous identity
(ADR-0038) — flowd never merges `main`, but branch protection is the structural
guarantee, not the code.

## Report back

Capture the run output (and any error). If the SDK shape differs from the wiring
(e.g. `createAgentSession`/`session.prompt`/`submit_verdict` behaviour), that's
the expected place for surprises — paste the error and we adjust the adapters.
