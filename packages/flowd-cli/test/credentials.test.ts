import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../src/credentials.ts";

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pf-cred-"));
  dirs.push(dir);
  return join(dir, "credentials.json");
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("FileCredentialStore", () => {
  test("a missing file reads as no key", async () => {
    const store = new FileCredentialStore(await tempPath());
    expect(await store.get("anthropic")).toBeNull();
  });

  test("set then get round-trips", async () => {
    const store = new FileCredentialStore(await tempPath());
    await store.set("anthropic", "sk-test");
    expect(await store.get("anthropic")).toBe("sk-test");
  });

  test("clear removes one key, leaves the others", async () => {
    const store = new FileCredentialStore(await tempPath());
    await store.set("anthropic", "a");
    await store.set("openai", "b");
    await store.clear("anthropic");
    expect(await store.get("anthropic")).toBeNull();
    expect(await store.get("openai")).toBe("b");
  });

  test("persists across store instances", async () => {
    const path = await tempPath();
    await new FileCredentialStore(path).set("anthropic", "sk-1");
    expect(await new FileCredentialStore(path).get("anthropic")).toBe("sk-1");
  });

  test("malformed JSON reads as empty and is NOT deleted", async () => {
    const path = await tempPath();
    await writeFile(path, "{ not json", "utf8");
    const store = new FileCredentialStore(path);
    expect(await store.get("anthropic")).toBeNull();
    expect(await readFile(path, "utf8")).toBe("{ not json"); // user file preserved
  });

  test("a too-new schema reads as empty and is NOT deleted", async () => {
    const path = await tempPath();
    const body = JSON.stringify({ schemaVersion: 999, keys: { anthropic: "secret" } });
    await writeFile(path, body, "utf8");
    const store = new FileCredentialStore(path);
    expect(await store.get("anthropic")).toBeNull();
    expect(await readFile(path, "utf8")).toBe(body); // secret preserved, not dropped
  });

  test("set refuses to overwrite a too-new file (preserves its keys)", async () => {
    const path = await tempPath();
    const body = JSON.stringify({
      schemaVersion: 999,
      keys: { anthropic: "v2-secret", openai: "v2" },
    });
    await writeFile(path, body, "utf8");
    const store = new FileCredentialStore(path);
    await expect(store.set("anthropic", "downgraded")).rejects.toThrow(/unreadable/);
    expect(await readFile(path, "utf8")).toBe(body); // not downgraded, keys intact
  });

  test("set refuses to overwrite a malformed file", async () => {
    const path = await tempPath();
    await writeFile(path, "{ not json", "utf8");
    const store = new FileCredentialStore(path);
    await expect(store.set("anthropic", "x")).rejects.toThrow(/unreadable/);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});
