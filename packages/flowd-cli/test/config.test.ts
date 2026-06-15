import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";

const VALID = {
  repo: "o/r",
  defaultBranch: "main",
  trackBranch: "track/x",
  workdir: ".flowd-workdir",
  actor: "flow-bot",
  aiDisclaimer: "[ai]",
  reviewerIterationCap: 2,
  verifyCommand: "bun run verify",
  credentialsPath: "~/.flowd/credentials.json",
  models: {
    implement: { provider: "anthropic", id: "claude-opus-4-8" },
    review: { provider: "openai", id: "gpt-5" },
    slice: { provider: "anthropic", id: "claude-opus-4-8" },
    planReview: { provider: "openai", id: "gpt-5" },
  },
};

describe("parseConfig", () => {
  test("accepts a complete, valid config", () => {
    expect(parseConfig(VALID)).toMatchObject({ repo: "o/r", reviewerIterationCap: 2 });
  });

  test("rejects a same implement/review model (invariant #2)", () => {
    const same = {
      ...VALID,
      models: {
        ...VALID.models,
        implement: { provider: "anthropic", id: "claude-opus-4-8" },
        review: { provider: "anthropic", id: "claude-opus-4-8" },
      },
    };
    expect(() => parseConfig(same)).toThrow(/invariant #2/);
  });

  test("rejects a missing required string", () => {
    const { repo, ...rest } = VALID;
    expect(() => parseConfig(rest)).toThrow(/repo/);
  });

  test("rejects a non-positive reviewerIterationCap", () => {
    expect(() => parseConfig({ ...VALID, reviewerIterationCap: 0 })).toThrow(
      /reviewerIterationCap/,
    );
  });

  test("rejects a malformed model entry", () => {
    expect(() => parseConfig({ ...VALID, models: { implement: {}, review: {} } })).toThrow(
      /provider/,
    );
  });
});
