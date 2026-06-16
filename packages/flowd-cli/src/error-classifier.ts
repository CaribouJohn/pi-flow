/**
 * Classify daemon tick errors as transient or fatal (PRD-0005 §4.1 / SPEC §8.7).
 *
 * Transient — network/5xx/429/timeout: the daemon backs off and retries.
 * Fatal     — auth 401/403, repo 404, config parse/validation, missing
 *             credential: the daemon halts immediately with a loud error.
 *
 * Unknown errors default to transient (prefer degraded over silent halt).
 */

export type ErrorKind = "transient" | "fatal";

/**
 * Classify an error thrown from the daemon tick function.
 *
 * Matching is purely on the error message string so the helper works with any
 * error shape produced by the forge adapters / GitHub CLI / config layer.
 */
export function classifyError(err: unknown): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  const lc = message.toLowerCase();

  // ── Fatal: authentication / authorisation ──────────────────────────────────
  if (
    /\b401\b/.test(message) ||
    /\b403\b/.test(message) ||
    lc.includes("unauthorized") ||
    lc.includes("forbidden") ||
    lc.includes("bad credentials")
  ) {
    return "fatal";
  }

  // ── Fatal: resource not found (repo, branch, etc.) ────────────────────────
  if (/\b404\b/.test(message) || lc.includes("repository not found")) {
    return "fatal";
  }

  // ── Fatal: config parse / validation errors ────────────────────────────────
  if (
    (lc.includes("config") || lc.includes("configuration")) &&
    (lc.includes("parse") ||
      lc.includes("invalid") ||
      lc.includes("validation") ||
      lc.includes("schema"))
  ) {
    return "fatal";
  }

  // ── Fatal: missing / unreadable credential ────────────────────────────────
  if (lc.includes("missing credential") || lc.includes("credential not found")) {
    return "fatal";
  }

  // ── Transient: HTTP 5xx or 429 (rate-limit) ───────────────────────────────
  if (/\b5\d{2}\b/.test(message) || /\b429\b/.test(message)) {
    return "transient";
  }

  // ── Transient: network / timeout ──────────────────────────────────────────
  if (
    lc.includes("network") ||
    lc.includes("timeout") ||
    lc.includes("timed out") ||
    lc.includes("econnrefused") ||
    lc.includes("econnreset") ||
    lc.includes("enotfound") ||
    lc.includes("etimedout") ||
    lc.includes("socket")
  ) {
    return "transient";
  }

  // Unknown errors default to transient — prefer degraded over silent halt.
  return "transient";
}
