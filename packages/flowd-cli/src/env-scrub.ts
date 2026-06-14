/**
 * Neutralize ambient provider API-key env vars at startup so flowd uses only
 * keys from the credential store (passed per-call), never the shell environment.
 * Ported from Hiss (ADR-0029 §4): Pi reads keys from the env by default, so we
 * scrub them and supply the key explicitly per session.
 */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
] as const;

/**
 * Delete the given provider key env vars from `env` (default `process.env`).
 * Returns the names that were present and removed (never their values).
 */
export function scrubProviderEnvKeys(
  env: Record<string, string | undefined> = process.env,
  names: readonly string[] = PROVIDER_ENV_KEYS,
): string[] {
  const removed: string[] = [];
  for (const name of names) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
