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
      `[forge-auth] no forge PAT found in the credential store under key "${FORGE_CREDENTIAL_KEY}". Store the flow-bot PAT with: flowd credentials set ${FORGE_CREDENTIAL_KEY} <PAT>. See docs/RUNBOOK.md — "flow-bot setup" for the one-time setup instructions.`,
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
 * Return a {@link CmdRunner} that injects `GH_TOKEN` into every subprocess it
 * spawns. Pass this to {@link GitForgeAdapter} so all `gh` and `git push` calls
 * authenticate as the flow-bot principal rather than the ambient user.
 */
export function makeForgeRunner(token: string): CmdRunner {
  return async (cmd, args, opts) => {
    const env = envWithToken(token);
    const proc = opts?.cwd ? $`${cmd} ${args}`.cwd(opts.cwd).env(env) : $`${cmd} ${args}`.env(env);
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
