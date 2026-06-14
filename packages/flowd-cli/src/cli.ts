import { FLOW_ENGINE_VERSION } from "@pi-flow/flow-engine";

/** Outcome of a CLI invocation: an exit code plus the text to print. */
export interface CliResult {
  code: number;
  message: string;
}

/** Parsed `flowd` arguments. */
export interface ParsedArgs {
  command: string | undefined;
  track: number | undefined;
}

const USAGE = `flowd ${FLOW_ENGINE_VERSION}\nusage: flowd run --track <n>`;

/**
 * Parse `flowd` argv (already stripped of the runtime + script path).
 * Recognises a positional command and the `--track <n>` flag.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let track: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--track") {
      const raw = rest[i + 1];
      track = raw === undefined ? undefined : Number(raw);
      i++;
    }
  }
  return { command, track };
}

/**
 * Run the CLI. The orchestrator loop is not wired yet (#82), so a valid
 * `run --track <n>` exits cleanly as a not-implemented stub; malformed
 * invocations return a non-zero usage error.
 */
export function run(argv: string[]): CliResult {
  const { command, track } = parseArgs(argv);

  if (command !== "run") {
    return { code: 2, message: USAGE };
  }
  if (track === undefined || Number.isNaN(track)) {
    return { code: 2, message: `error: --track <n> is required\n${USAGE}` };
  }

  return {
    code: 0,
    message: `flowd run --track ${track}: not implemented yet (orchestrator lands in #82)`,
  };
}
