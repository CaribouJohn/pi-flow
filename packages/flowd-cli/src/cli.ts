import { FLOW_ENGINE_VERSION } from "@pi-flow/flow-engine";

/** Parsed `flowd` arguments. */
export interface ParsedArgs {
  command: string | undefined;
  track: number | undefined;
  issue: number | undefined;
  prd: string | undefined;
  reason: string | undefined;
  config: string | undefined;
}

const USAGE = [
  `flowd ${FLOW_ENGINE_VERSION}`,
  "usage: flowd run --track <n> [--config <path>]",
  "       flowd plan --issue <n> --prd <path> [--config <path>]",
  "       flowd reject --track <n> --reason <text> [--config <path>]",
  "       flowd accept --track <n> [--config <path>]",
  "       flowd calibrate [--config <path>]",
].join("\n");

/**
 * Parse `flowd` argv (already stripped of the runtime + script path).
 * Recognises a positional command, `--track <n>`, `--issue <n>`, `--prd <path>`,
 * `--reason <text>`, and `--config <path>`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let track: number | undefined;
  let issue: number | undefined;
  let prd: string | undefined;
  let reason: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--track") {
      const raw = rest[i + 1];
      const n = Number(raw);
      track = raw === undefined || !Number.isInteger(n) ? undefined : n;
      i++;
    } else if (rest[i] === "--issue") {
      const raw = rest[i + 1];
      const n = Number(raw);
      issue = raw === undefined || !Number.isInteger(n) ? undefined : n;
      i++;
    } else if (rest[i] === "--prd") {
      prd = rest[i + 1];
      i++;
    } else if (rest[i] === "--reason") {
      reason = rest[i + 1];
      i++;
    } else if (rest[i] === "--config") {
      config = rest[i + 1];
      i++;
    }
  }
  return { command, track, issue, prd, reason, config };
}

/** What the CLI should do: report a usage error, run a track, run a plan, reject, accept, or calibrate. */
export type RunPlan =
  | { kind: "usage"; code: number; message: string }
  | { kind: "run"; track: number; config: string | undefined }
  | { kind: "plan"; issue: number; prd: string; config: string | undefined }
  | { kind: "reject"; track: number; reason: string; config: string | undefined }
  | { kind: "accept"; track: number; config: string | undefined }
  | { kind: "calibrate"; config: string | undefined };

/** Validate the invocation and decide what to do (pure; the entry runs it). */
export function planInvocation(argv: string[]): RunPlan {
  const { command, track, issue, prd, reason, config } = parseArgs(argv);

  if (command === "run") {
    if (track === undefined || !Number.isInteger(track) || track < 1) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --track <n> must be a positive integer\n${USAGE}`,
      };
    }
    return { kind: "run", track, config };
  }

  if (command === "reject") {
    if (track === undefined || !Number.isInteger(track) || track < 1) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --track <n> must be a positive integer\n${USAGE}`,
      };
    }
    if (reason === undefined || reason.length === 0) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --reason <text> is required for reject\n${USAGE}`,
      };
    }
    return { kind: "reject", track, reason, config };
  }

  if (command === "accept") {
    if (track === undefined || !Number.isInteger(track) || track < 1) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --track <n> must be a positive integer\n${USAGE}`,
      };
    }
    return { kind: "accept", track, config };
  }

  if (command === "calibrate") {
    return { kind: "calibrate", config };
  }

  if (command === "plan") {
    if (issue === undefined || !Number.isInteger(issue) || issue < 1) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --issue <n> must be a positive integer\n${USAGE}`,
      };
    }
    if (prd === undefined || prd.length === 0) {
      return {
        kind: "usage",
        code: 2,
        message: `error: --prd <path> is required for plan\n${USAGE}`,
      };
    }
    return { kind: "plan", issue, prd, config };
  }

  return { kind: "usage", code: 2, message: USAGE };
}
