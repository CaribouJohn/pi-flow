import type { CredentialStore } from "../src/credentials.ts";

/** An in-memory CredentialStore for tests. */
export function makeCredentials(keys: Record<string, string>): CredentialStore {
  const map = new Map(Object.entries(keys));
  return {
    get: async (p) => map.get(p) ?? null,
    set: async (p, k) => {
      map.set(p, k);
    },
    clear: async (p) => {
      map.delete(p);
    },
  };
}
