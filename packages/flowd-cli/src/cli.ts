import { FLOW_ENGINE_VERSION } from "@pi-flow/flow-engine";

/** Parsed `flowd` arguments. */
export interface ParsedArgs {
  command: string | undefined;
  track: number | undefined;
  config: string | undefined;
}

const USAGE = `flowd ${FLOW_ENGINE_VERSION}\nusage: flowd run --track <n> [--config <path>]`;

/**
 * Parse `flowd` argv (already stripped of the runtime + script path).
 * Recognises a positional command, `--track <n>`, and `--config <path>`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let track: number | undefined;
  let config: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--track") {
      const raw = rest[i + 1];
      track = raw === undefined ? undefined : Number(raw);
      i++;
    } else if (rest[i] === "--config") {
      config = rest[i + 1];
      i++;
    }
  }
  return { command, track, config };
}

/** What the CLI should do: report a usage error, or run a track. */
export type RunPlan =
  | { kind: "usage"; code: number; message: string }
  | { kind: "run"; track: number; config: string | undefined };

/** Validate the invocation and decide what to do (pure; the entry runs it). */
export function planInvocation(argv: string[]): RunPlan {
  const { command, track, config } = parseArgs(argv);
  if (command !== "run") {
    return { kind: "usage", code: 2, message: USAGE };
  }
  if (track === undefined || !Number.isInteger(track) || track < 1) {
    return {
      kind: "usage",
      code: 2,
      message: `error: --track <n> must be a positive integer\n${USAGE}`,
    };
  }
  return { kind: "run", track, config };
}
