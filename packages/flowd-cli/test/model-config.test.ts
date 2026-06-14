import { describe, expect, test } from "bun:test";
import { type RoleModelConfig, sameModel, validateRoleModelConfig } from "../src/model-config.ts";

describe("validateRoleModelConfig", () => {
  test("accepts distinct implement/review models (cross-provider)", () => {
    const config: RoleModelConfig = {
      implement: { provider: "anthropic", id: "claude-opus-4-8" },
      review: { provider: "openai", id: "gpt-5" },
    };
    expect(() => validateRoleModelConfig(config)).not.toThrow();
  });

  test("accepts same provider with different model ids", () => {
    const config: RoleModelConfig = {
      implement: { provider: "anthropic", id: "claude-opus-4-8" },
      review: { provider: "anthropic", id: "claude-haiku-4-5" },
    };
    expect(() => validateRoleModelConfig(config)).not.toThrow();
  });

  test("rejects an identical implement/review model (invariant #2)", () => {
    const config: RoleModelConfig = {
      implement: { provider: "anthropic", id: "claude-opus-4-8" },
      review: { provider: "anthropic", id: "claude-opus-4-8" },
    };
    expect(() => validateRoleModelConfig(config)).toThrow(/invariant #2/);
  });
});

describe("sameModel", () => {
  test("compares provider and id", () => {
    expect(sameModel({ provider: "a", id: "x" }, { provider: "a", id: "x" })).toBe(true);
    expect(sameModel({ provider: "a", id: "x" }, { provider: "a", id: "y" })).toBe(false);
    expect(sameModel({ provider: "a", id: "x" }, { provider: "b", id: "x" })).toBe(false);
  });
});
