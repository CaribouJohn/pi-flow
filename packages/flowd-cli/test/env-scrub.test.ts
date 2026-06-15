import { describe, expect, test } from "bun:test";
import { PROVIDER_ENV_KEYS, scrubProviderEnvKeys } from "../src/env-scrub.ts";

describe("scrubProviderEnvKeys", () => {
  test("removes present provider keys and reports their names", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret2",
      PATH: "/usr/bin",
    };
    const removed = scrubProviderEnvKeys(env);
    expect(removed).toContain("ANTHROPIC_API_KEY");
    expect(removed).toContain("OPENAI_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin"); // non-provider vars untouched
  });

  test("is a no-op when no provider keys are present", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(scrubProviderEnvKeys(env)).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("PROVIDER_ENV_KEYS covers the common providers", () => {
    expect(PROVIDER_ENV_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(PROVIDER_ENV_KEYS).toContain("OPENAI_API_KEY");
  });
});
