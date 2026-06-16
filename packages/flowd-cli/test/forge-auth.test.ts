import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_CREDENTIAL_KEY, FileCredentialStore } from "../src/credentials.ts";
import { makeForgeGhRunner, makeForgeRunner, readForgeToken } from "../src/forge-auth.ts";
import { makeCredentials } from "./helpers.ts";

// ── temp dirs for FileCredentialStore tests ────────────────────────────────

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pf-forge-auth-"));
  dirs.push(dir);
  return join(dir, "credentials.json");
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ── readForgeToken ─────────────────────────────────────────────────────────

describe("readForgeToken", () => {
  test("throws a clear error when the forge key is absent (in-memory store)", async () => {
    const store = makeCredentials({});
    await expect(readForgeToken(store)).rejects.toThrow(FORGE_CREDENTIAL_KEY);
  });

  test("error message names the reserved key and points to the RUNBOOK", async () => {
    const store = makeCredentials({});
    let msg = "";
    try {
      await readForgeToken(store);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain(FORGE_CREDENTIAL_KEY);
    expect(msg).toContain("RUNBOOK");
  });

  test("error message instructs editing .flowd/credentials.json and does not reference flowd credentials set", async () => {
    const store = makeCredentials({});
    let msg = "";
    try {
      await readForgeToken(store);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain(".flowd/credentials.json");
    expect(msg).toContain(`"${FORGE_CREDENTIAL_KEY}"`);
    expect(msg).not.toContain("flowd credentials set");
  });

  test("returns the stored PAT when present (in-memory store)", async () => {
    const store = makeCredentials({ [FORGE_CREDENTIAL_KEY]: "ghp_in_memory_token" });
    expect(await readForgeToken(store)).toBe("ghp_in_memory_token");
  });

  test("throws when forge key is absent from a real FileCredentialStore", async () => {
    const store = new FileCredentialStore(await tempPath());
    await expect(readForgeToken(store)).rejects.toThrow(FORGE_CREDENTIAL_KEY);
  });

  test("returns the stored PAT from a real FileCredentialStore", async () => {
    const store = new FileCredentialStore(await tempPath());
    await store.set(FORGE_CREDENTIAL_KEY, "ghp_file_store_token");
    expect(await readForgeToken(store)).toBe("ghp_file_store_token");
  });

  test("does not expose the token in the error message (other keys present)", async () => {
    const store = makeCredentials({ anthropic: "sk-secret", openai: "sk-other" });
    let msg = "";
    try {
      await readForgeToken(store);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    // Error must not leak other keys' values
    expect(msg).not.toContain("sk-secret");
    expect(msg).not.toContain("sk-other");
  });
});

// ── makeForgeRunner ────────────────────────────────────────────────────────

describe("makeForgeRunner", () => {
  test("returns a callable CmdRunner", () => {
    const runner = makeForgeRunner("ghp_any_token");
    expect(typeof runner).toBe("function");
  });

  test("injects GH_TOKEN into the subprocess environment", async () => {
    const runner = makeForgeRunner("ghp_injected_token");
    // sh is on PATH (ships with Git for Windows; RUNBOOK §1 prerequisite)
    const out = await runner("sh", ["-c", "printf '%s' \"$GH_TOKEN\""]);
    expect(out.trim()).toBe("ghp_injected_token");
  });

  test("overrides any existing GH_TOKEN with the forge PAT", async () => {
    // Temporarily set GH_TOKEN to a different value in process.env
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_ambient_should_be_overridden";
    try {
      const runner = makeForgeRunner("ghp_forge_overrides");
      const out = await runner("sh", ["-c", "printf '%s' \"$GH_TOKEN\""]);
      expect(out.trim()).toBe("ghp_forge_overrides");
    } finally {
      if (prev === undefined) {
        process.env.GH_TOKEN = undefined;
      } else {
        process.env.GH_TOKEN = prev;
      }
    }
  });
});

// ── makeForgeGhRunner ──────────────────────────────────────────────────────

describe("makeForgeGhRunner", () => {
  test("returns a callable GhRunner", () => {
    const runner = makeForgeGhRunner("ghp_any_token");
    expect(typeof runner).toBe("function");
  });
});

// ── FORGE_CREDENTIAL_KEY constant ─────────────────────────────────────────

describe("FORGE_CREDENTIAL_KEY", () => {
  test('is the string "forge"', () => {
    expect(FORGE_CREDENTIAL_KEY).toBe("forge");
  });
});
