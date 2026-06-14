# ADR-0038: `flow-bot` identity & how "the harness never merges `main`" is actually enforced

## Status

Accepted — corrects HARNESS-DESIGN §5/§9 and SPEC §9 invariant #1, which over-claimed
that a *token scope* makes the autonomous service "permission-incapable of touching
`main`."

## Context

HARNESS-DESIGN decision #9 and §5/§9 stated that all autonomous work runs as `flow-bot`
with a **scoped token** that is "permission-incapable of merging `main`," and that
invariant #1 (`harness_never_merges_main`) is therefore "enforced by permission scope,
not code-convention / trust."

That is not how GitHub tokens work. Token permissions are **repo-scoped, not
branch-scoped**: a fine-grained PAT (or App installation token) carrying `contents:
write` can push/merge to *every* branch in the repo, including `main`. There is no token
scope expressing "may merge `track/*` but not `main`." So a token alone cannot enforce
invariant #1, and a distinct `flow-bot` token per repo (let alone per track) would also
be a provisioning burden as the product goes multi-repo.

## Decision

"The harness never merges `main`" is enforced by **three layers, of which the token is
the weakest** — the structural lever is branch protection, not token scope:

1. **Branch protection on `main` (the structural lever).** Protect `main`: require a PR,
   require an approving review from a non-author, and **restrict who may push/merge** to
   the maintainer (or a team that excludes `flow-bot`). This is per-repo config set once,
   not per-track. It is what actually makes a `main` merge by the autonomous identity
   *impossible*, regardless of token scope.

2. **`flow-bot` as a distinct principal.** Its real jobs are (a) clean attribution
   (*"flow-bot built it"*) and (b) being an identity that branch protection / CODEOWNERS
   can treat differently from the maintainer. The maintainer's in-app **Accept & merge**
   uses the *maintainer's* credentials, which the protection rule allows on `main`.
   - **Multi-repo identity = a GitHub App**, not a fleet of PATs: one App, installed
     per repo, minting short-lived per-repo installation tokens automatically. This is
     the "different token per repo" the original design gestured at, done without
     managing N long-lived PATs. A single-repo deployment may use a bot-account PAT.

3. **No `main`-merge code in the autonomous path (defence-in-depth).** flowd simply
   never calls merge against `main`; the only main-merge path is the maintainer's
   explicit Accept & merge action under their own creds. This is a backstop, **not** the
   primary guarantee — the primary guarantee is layer 1.

For the **headless walking-skeleton PRD** none of this is exercised (there is no
main-merge code, and slices merge only into the track branch). It uses ordinary
`gh`/PAT auth from the environment and relies on layer 3 alone; the `flow-bot` App +
branch-protection model lands with the acceptance / main-merge PRD, the first place the
boundary actually constrains anything.

## Consequences

- HARNESS-DESIGN §5/§9 and SPEC invariant #1 are reworded: the enforcement is
  branch-protection-first, identity-second, code-third — not "token scope."
- Standing up a repo for autonomous Flow now has a **setup precondition**: configure
  branch protection on `main` excluding `flow-bot`. Without it, invariant #1 is enforced
  only by code-convention (layer 3) — acceptable for a sandbox, not for a real repo.
- The identity PRD must choose **GitHub App vs bot PAT** per deployment (App for
  multi-repo). That choice carries lock-in and is recorded here so it isn't re-litigated.
