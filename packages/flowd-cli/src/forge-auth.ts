import { $ } from "bun";
import { type CredentialStore, FORGE_CREDENTIAL_KEY } from "./credentials.ts";
import type { CmdRunner } from "./git-forge.ts";
import type { GhRunner } from "./github-tracker.ts";

/**
 * Read the forge PAT from the credential store under the reserved `"forge"` key.
 *
 * Throws a clear, actionable error when absent — flowd never falls back to
 * ambient `GH_TOKEN` or the `gh` session so that all forge operations are
 * unambiguously attributed to the flow-bot principal (ADR-0038).
 */
export async function readForgeToken(store: CredentialStore): Promise<string> {
  const token = await store.get(FORGE_CREDENTIAL_KEY);
  if (token === null) {
    throw new Error(
      `[forge-auth] no forge PAT found in the credential store under key "${FORGE_CREDENTIAL_KEY}". Add the flow-bot PAT by editing .flowd/credentials.json and setting the "${FORGE_CREDENTIAL_KEY}" key to your PAT value. See docs/RUNBOOK.md — "flow-bot setup" for the one-time setup instructions.`,
    );
  }
  return token;
}

/**
 * Build a merged env record from the current process env with `GH_TOKEN`
 * overridden by the supplied forge PAT. Undefined values are dropped so the
 * result is `Record<string, string>` and safe to pass to Bun's `$.env()`.
 */
function envWithToken(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GH_TOKEN = token;
  return env;
}

/**
 * Return a {@link CmdRunner} that authenticates every subprocess it spawns as
 * the flow-bot principal (ADR-0038).
 *
 * - `gh` commands: re-identified via `GH_TOKEN` in the subprocess env.
 * - `git` commands: re-identified via `-c http.extraheader="AUTHORIZATION:
 *   basic <base64(x-access-token:token)>"` so that `git push` / `git fetch`
 *   reach GitHub as flow-bot rather than the ambient OS credential-store user.
 *   `GH_TOKEN` alone only affects the `gh` CLI; raw git ignores it and falls
 *   back to the OS credential manager (the human), which breaks the last-pusher
 *   invariant and causes the maintainer to be blocked at the track→main merge.
 *   The scheme must be **basic** (not bearer): a classic PAT authenticates to
 *   git-over-HTTPS via basic auth; `bearer` is rejected (verified live — git
 *   falls through to a credential prompt and the push fails).
 *
 * The `-c` flag is a per-invocation override and is never persisted to
 * `.git/config`, satisfying the no-persist requirement.
 */
export function makeForgeRunner(token: string): CmdRunner {
  return async (cmd, args, opts) => {
    const env = envWithToken(token);
    // Prepend the per-invocation extraheader for all git commands so that
    // git push/fetch authenticate as the token holder, not the OS user.
    // Basic auth: username is the conventional `x-access-token`, password is
    // the PAT (the same scheme as the `x-access-token:<pat>@github.com` URL form).
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    const actualArgs =
      cmd === "git" ? ["-c", `http.extraheader=AUTHORIZATION: basic ${basicAuth}`, ...args] : args;
    const proc = opts?.cwd
      ? $`${cmd} ${actualArgs}`.cwd(opts.cwd).env(env)
      : $`${cmd} ${actualArgs}`.env(env);
    return await proc.text();
  };
}

/**
 * Return a {@link GhRunner} that injects `GH_TOKEN` into every `gh` subprocess.
 * Pass this to {@link GitHubTrackerAdapter} so all tracker writes (issues,
 * comments, labels) are authored by the flow-bot principal.
 */
export function makeForgeGhRunner(token: string): GhRunner {
  return async (args) => await $`gh ${args}`.env(envWithToken(token)).text();
}
