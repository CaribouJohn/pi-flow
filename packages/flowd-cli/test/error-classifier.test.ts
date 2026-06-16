import { describe, expect, test } from "bun:test";
import { classifyError } from "../src/error-classifier.ts";

// ── Fatal errors ──────────────────────────────────────────────────────────────

describe("classifyError — fatal", () => {
  test("HTTP 401 is fatal", () => {
    expect(classifyError(new Error("HTTP 401 Unauthorized"))).toBe("fatal");
  });

  test("HTTP 403 is fatal", () => {
    expect(classifyError(new Error("Request failed with status 403"))).toBe("fatal");
  });

  test("'unauthorized' in message is fatal", () => {
    expect(classifyError(new Error("unauthorized: bad token"))).toBe("fatal");
  });

  test("'forbidden' in message is fatal", () => {
    expect(classifyError(new Error("forbidden resource access"))).toBe("fatal");
  });

  test("'bad credentials' is fatal", () => {
    expect(classifyError(new Error("Bad credentials"))).toBe("fatal");
  });

  test("HTTP 404 is fatal", () => {
    expect(classifyError(new Error("404 Not Found"))).toBe("fatal");
  });

  test("'repository not found' is fatal", () => {
    expect(classifyError(new Error("repository not found: owner/repo"))).toBe("fatal");
  });

  test("config parse error is fatal", () => {
    expect(classifyError(new Error("config parse error: unexpected token"))).toBe("fatal");
  });

  test("invalid config is fatal", () => {
    expect(classifyError(new Error("invalid config: missing required field"))).toBe("fatal");
  });

  test("config validation error is fatal", () => {
    expect(classifyError(new Error("config validation failed"))).toBe("fatal");
  });

  test("config schema error is fatal", () => {
    expect(classifyError(new Error("invalid config schema"))).toBe("fatal");
  });

  test("missing credential is fatal", () => {
    expect(classifyError(new Error("missing credential: GITHUB_TOKEN"))).toBe("fatal");
  });

  test("credential not found is fatal", () => {
    expect(classifyError(new Error("credential not found for host github.com"))).toBe("fatal");
  });
});

// ── Transient errors ──────────────────────────────────────────────────────────

describe("classifyError — transient", () => {
  test("HTTP 500 is transient", () => {
    expect(classifyError(new Error("500 Internal Server Error"))).toBe("transient");
  });

  test("HTTP 502 is transient", () => {
    expect(classifyError(new Error("502 Bad Gateway"))).toBe("transient");
  });

  test("HTTP 503 is transient", () => {
    expect(classifyError(new Error("503 Service Unavailable"))).toBe("transient");
  });

  test("HTTP 429 rate limit is transient", () => {
    expect(classifyError(new Error("429 Too Many Requests"))).toBe("transient");
  });

  test("network timeout is transient", () => {
    expect(classifyError(new Error("network timeout"))).toBe("transient");
  });

  test("timed out is transient", () => {
    expect(classifyError(new Error("Request timed out after 30s"))).toBe("transient");
  });

  test("ECONNREFUSED is transient", () => {
    expect(classifyError(new Error("ECONNREFUSED 127.0.0.1:443"))).toBe("transient");
  });

  test("ECONNRESET is transient", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
  });

  test("ENOTFOUND is transient", () => {
    expect(classifyError(new Error("ENOTFOUND api.github.com"))).toBe("transient");
  });

  test("ETIMEDOUT is transient", () => {
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("transient");
  });

  test("socket hang up is transient", () => {
    expect(classifyError(new Error("socket hang up"))).toBe("transient");
  });

  test("generic unknown error defaults to transient", () => {
    expect(classifyError(new Error("something unexpected happened"))).toBe("transient");
  });

  test("non-Error values are treated as transient (string)", () => {
    expect(classifyError("some string error")).toBe("transient");
  });

  test("non-Error values are treated as transient (object)", () => {
    expect(classifyError({ code: "UNKNOWN" })).toBe("transient");
  });
});
