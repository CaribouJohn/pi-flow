/**
 * Mutation-token registry — the buffer between flow_set_state and the AFK
 * poller. When a flow tool mutates an issue's state label, it records a
 * token (issue + new state + expiry). The poller, when it sees a state
 * change, checks the registry first: if it matches a recent token, the
 * change is ours (already optimistically applied), so the poller ignores
 * it. Without this, every mutation would round-trip through the poller as
 * a phantom external event.
 *
 * Pure in-memory, single-process. If pi restarts, the registry resets —
 * worst case the poller treats one of our own mutations as external,
 * which is benign (it just notifies redundantly).
 *
 * Default TTL = 10s (per the AFK design discussion). Long enough to cover
 * the worst-case poll latency (60s adaptive max + GitHub propagation), no
 * — actually that means we should re-think. Let's set the default at the
 * profile.poll_cadence_seconds + a safety margin when wired (caller can
 * override). For A7 we ship with the simple 10s default and let B-track
 * tune at the poller-wiring slice.
 */

import type { State } from "./state-machine.ts";

export type MutationToken = {
  issueNumber: number;
  newState: State;
  recordedAt: number;
  expiresAt: number;
};

export type MutationRegistry = {
  /** Record that we just transitioned `issueNumber` to `newState`. */
  record(issueNumber: number, newState: State): MutationToken;
  /**
   * Return the most recent un-expired token for an issue (and prune it on
   * read so it can't satisfy a second phantom event). Returns null if none.
   */
  consume(issueNumber: number, now?: number): MutationToken | null;
  /** Peek without consuming (for debugging / status UI). */
  peek(issueNumber: number, now?: number): MutationToken | null;
  /** Drop everything expired before `now` (defaults to Date.now()). */
  prune(now?: number): void;
  /** Inspection helper for tests / status widgets. */
  size(): number;
};

export function createMutationRegistry(ttlMs = 10_000): MutationRegistry {
  const tokens = new Map<number, MutationToken>();

  function pruneInternal(now: number) {
    for (const [num, t] of tokens) {
      if (t.expiresAt <= now) tokens.delete(num);
    }
  }

  return {
    record(issueNumber, newState) {
      const now = Date.now();
      const token: MutationToken = {
        issueNumber,
        newState,
        recordedAt: now,
        expiresAt: now + ttlMs,
      };
      tokens.set(issueNumber, token);
      return token;
    },
    consume(issueNumber, now = Date.now()) {
      pruneInternal(now);
      const t = tokens.get(issueNumber);
      if (!t) return null;
      tokens.delete(issueNumber);
      return t;
    },
    peek(issueNumber, now = Date.now()) {
      pruneInternal(now);
      return tokens.get(issueNumber) ?? null;
    },
    prune(now = Date.now()) {
      pruneInternal(now);
    },
    size() {
      return tokens.size;
    },
  };
}
