import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { platform } from "node:process";

/**
 * Local store for provider API keys, addressed by provider id. Ported from
 * Hiss (`hiss-core/src/credential-store.ts`): the key lives outside any
 * introspectable config so an agent can never read its own secret, and is fed
 * per-call into `authStorage.setRuntimeApiKey()` rather than the ambient env.
 *
 * v1 backend is a 0600 JSON file. A too-new or malformed file is read as
 * "no keys" but is **never deleted** — silently dropping a user secret is worse
 * than re-reading it once the right build runs. Implementations must never log
 * the key.
 */
export const CREDENTIAL_SCHEMA_VERSION = 1;

export interface CredentialStore {
  /** The stored key for a provider, or `null` if none is set. */
  get(provider: string): Promise<string | null>;
  /** Store (or replace) the key for a provider. */
  set(provider: string, key: string): Promise<void>;
  /** Remove the key for a provider. No-op if absent. */
  clear(provider: string): Promise<void>;
}

interface CredentialsFile {
  readonly schemaVersion: number;
  readonly keys: Record<string, string>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  async get(provider: string): Promise<string | null> {
    const keys = await this.load();
    const key = keys[provider];
    return typeof key === "string" && key.length > 0 ? key : null;
  }

  async set(provider: string, key: string): Promise<void> {
    const keys = await this.load();
    keys[provider] = key;
    await this.save(keys);
  }

  async clear(provider: string): Promise<void> {
    const keys = await this.load();
    if (!(provider in keys)) return;
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) if (k !== provider) rest[k] = v;
    await this.save(rest);
  }

  private async load(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (isFileNotFound(err)) return {};
      console.warn(`[credentials] read failed for ${this.path}:`, err);
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      console.warn(`[credentials] malformed JSON at ${this.path}:`, err);
      return {};
    }

    const version = readSchemaVersion(parsed);
    if (version > CREDENTIAL_SCHEMA_VERSION) {
      // Preserve user secrets — read as empty, do NOT delete the newer file.
      console.warn(
        `[credentials] ${this.path} is too new (schemaVersion ${version} > ${CREDENTIAL_SCHEMA_VERSION}); ignoring, not deleting`,
      );
      return {};
    }
    return extractKeys(parsed);
  }

  private async save(keys: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const onDisk: CredentialsFile = { schemaVersion: CREDENTIAL_SCHEMA_VERSION, keys };
    await writeFile(this.path, JSON.stringify(onDisk, null, 2), "utf8");
    if (platform !== "win32") await chmod(this.path, 0o600);
  }
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function readSchemaVersion(blob: unknown): number {
  if (typeof blob !== "object" || blob === null) return 0;
  const v = (blob as Record<string, unknown>).schemaVersion;
  return typeof v === "number" ? v : 0;
}

function extractKeys(blob: unknown): Record<string, string> {
  if (typeof blob !== "object" || blob === null) return {};
  const keys = (blob as Record<string, unknown>).keys;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return {};
  const out: Record<string, string> = {};
  for (const [provider, value] of Object.entries(keys as Record<string, unknown>)) {
    if (typeof value === "string") out[provider] = value;
  }
  return out;
}
