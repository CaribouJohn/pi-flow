/**
 * spawn-pi — generic helper to spawn a `pi` subprocess in non-interactive
 * JSON mode and collect a structured result.
 *
 * This is the layer the subagent example (`examples/extensions/subagent/`)
 * cherry-picks from; we re-implement the load-bearing bits in 150 lines
 * so we own the contract.
 *
 * Two consumers in pi-flow:
 *   - `implement-spawn.ts` — B6 implementer sub-agent
 *   - `review-spawn.ts`    — B7 reviewer sub-agent
 *
 * Both depend on:
 *   1. spawning `pi --mode json -p --no-session [...]`
 *   2. streaming JSON events on stdout (line-delimited)
 *   3. capturing the final assistant text + exit code + stderr
 *   4. abort-signal-driven cleanup (SIGTERM, then SIGKILL after 5s)
 *
 * The spawn function itself is dependency-injected so the smoke test
 * can exercise the full streaming/parsing/abort path against a fake
 * child process without actually launching `pi`.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";import { existsSync } from "node:fs";
import { basename } from "node:path";

// --- DI-friendly spawn surface --------------------------------------

/**
 * Minimal subset of `ChildProcess` we touch. Lets tests stand up a
 * fake without faking the whole node:child_process surface. We only
 * need `on("data", ...)` on the streams, not the full ReadableStream.
 */
export type SpawnedStream = {
  on(event: "data", cb: (chunk: Buffer | string) => void): void;
};

export type SpawnedProc = {
  stdout: SpawnedStream | null;
  stderr: SpawnedStream | null;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  killed: boolean;
};

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProc;

const defaultSpawn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as SpawnedProc;

// --- options + result -----------------------------------------------

export type SpawnPiOptions = {
  /** Working directory for the child. */
  cwd: string;
  /** The task prompt (becomes the final positional `pi` arg). */
  task: string;
  /** Optional file path appended via `--append-system-prompt`. */
  systemPromptFile?: string;
  /** Optional model pattern; omitted means the child uses its default. */
  model?: string;
  /**
   * Optional tool allowlist passed via `--tools a,b,c`. Empty/undefined
   * means the child uses its default toolset.
   */
  tools?: string[];
  /**
   * Extra env vars merged on top of the parent's env. Use this to set
   * recursion-guard markers (`PI_FLOW_SPAWN_DEPTH`) or to hand the
   * child a result-file path (`PI_FLOW_RESULT_FILE`).
   */
  env?: Record<string, string>;
  /** Abort the child (SIGTERM, then SIGKILL after `killGraceMs`). */
  signal?: AbortSignal;
  /**
   * Milliseconds to wait between SIGTERM and SIGKILL. Default 5000.
   * Lowered in tests to keep the smoke fast.
   */
  killGraceMs?: number;
  /** Inject a fake spawn for testing. */
  spawnImpl?: SpawnFn;
  /** Inject setTimeout for testing (advance kill grace deterministically). */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
};

export type SpawnPiResult = {
  exitCode: number;
  wasAborted: boolean;
  /**
   * Concatenated text from every `assistant` `message_end` event's
   * text parts, in arrival order. Empty string if the child produced
   * no assistant text (e.g., crashed early).
   */
  assistantText: string;
  /** Concatenated stderr from the child. */
  stderr: string;
  /**
   * Number of `assistant` `message_end` events observed. Useful as a
   * cheap "did the child actually do anything" signal.
   */
  assistantTurns: number;
  /**
   * The exact arg vector used to launch the child, for diagnostics.
   * The first element is the command (e.g., `pi` or `/usr/bin/pi`).
   */
  invocation: { command: string; args: string[] };
};

// --- pi binary resolution -------------------------------------------

/**
 * Decide how to launch `pi` from inside an extension running under
 * `pi` itself. Three cases (mirrors the subagent example):
 *
 *   1. `process.argv[1]` points at a real on-disk script → use the
 *      current runtime + that script.
 *   2. We're running under a non-bun/node runtime (the `pi`
 *      single-file executable) → use `process.execPath` directly.
 *   3. Bun virtual-fs path → fall back to `pi` on PATH.
 */
export function resolvePiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }
  return { command: "pi", args: [] };
}

// --- arg-vector builder (pure) --------------------------------------

/**
 * Build the full arg vector for `pi --mode json -p --no-session ...`.
 * Pure so the smoke can assert the exact shape.
 */
export function buildPiArgs(opts: {
  task: string;
  systemPromptFile?: string;
  model?: string;
  tools?: string[];
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }
  if (opts.systemPromptFile) {
    args.push("--append-system-prompt", opts.systemPromptFile);
  }
  // Final positional: the task prompt. Plain text, no `Task: ` prefix —
  // callers compose their own prompt in implement-spawn / review-spawn.
  args.push(opts.task);
  return args;
}

// --- stream parser (pure) -------------------------------------------

/**
 * Parse one line of pi's `--mode json` output and update the accumulator.
 *
 * Unknown event types are silently ignored — pi may add new ones and a
 * forwards-compatible parser is cheaper than chasing the spec.
 */
export function parseStreamLine(
  line: string,
  acc: { assistantText: string; assistantTurns: number },
): void {
  if (!line.trim()) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return; // garbled line; pi shouldn't emit these but be defensive
  }
  if (!event || typeof event !== "object") return;
  const e = event as { type?: unknown; message?: unknown };
  if (e.type !== "message_end" || !e.message) return;

  const msg = e.message as {
    role?: unknown;
    content?: unknown;
  };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;

  acc.assistantTurns++;
  for (const part of msg.content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      acc.assistantText += (part as { text: string }).text;
    }
  }
}

// --- main entry point -----------------------------------------------

export async function spawnPi(opts: SpawnPiOptions): Promise<SpawnPiResult> {
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const setTimeoutImpl =
    opts.setTimeoutImpl ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms));

  const baseInvocation = resolvePiInvocation();
  const piArgs = buildPiArgs({
    task: opts.task,
    systemPromptFile: opts.systemPromptFile,
    model: opts.model,
    tools: opts.tools,
  });
  const args = [...baseInvocation.args, ...piArgs];
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };

  const acc = { assistantText: "", assistantTurns: 0 };
  let stderr = "";
  let buffer = "";
  let wasAborted = false;

  const proc = spawnImpl(baseInvocation.command, args, { cwd: opts.cwd, env });

  const flushLine = (line: string) => parseStreamLine(line, acc);

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) flushLine(line);
  });

  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) flushLine(buffer);
      resolve(code ?? 0);
    });
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(1);
    });

    if (opts.signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeoutImpl(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, opts.killGraceMs ?? 5000);
      };
      if (opts.signal.aborted) killProc();
      else opts.signal.addEventListener("abort", killProc, { once: true });
    }
  });

  return {
    exitCode,
    wasAborted,
    assistantText: acc.assistantText,
    assistantTurns: acc.assistantTurns,
    stderr,
    invocation: { command: baseInvocation.command, args },
  };
}
