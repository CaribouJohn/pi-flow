/**
 * Smoke for spawn-pi. Run with:
 *   bun extension/spawn-pi.smoke.ts
 *
 * The real `spawnPi` shells out to a `pi` subprocess. To keep the
 * smoke hermetic we DI a fake spawn that simulates stdout/stderr
 * streams and a close event.
 */

import { EventEmitter } from "node:events";
import {
  buildPiArgs,
  parseStreamLine,
  resolvePiInvocation,
  spawnPi,
  type SpawnedProc,
  type SpawnFn,
} from "./spawn-pi.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- buildPiArgs ---
{
  const a = buildPiArgs({ task: "hello" });
  check(
    "minimal args",
    JSON.stringify(a) ===
      JSON.stringify(["--mode", "json", "-p", "--no-session", "hello"]),
    JSON.stringify(a),
  );

  const b = buildPiArgs({
    task: "do it",
    model: "claude-haiku-4-5",
    tools: ["read", "bash", "edit"],
    systemPromptFile: "/tmp/sys.md",
  });
  check(
    "args include model / tools / system-prompt in correct order",
    JSON.stringify(b) ===
      JSON.stringify([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        "claude-haiku-4-5",
        "--tools",
        "read,bash,edit",
        "--append-system-prompt",
        "/tmp/sys.md",
        "do it",
      ]),
    JSON.stringify(b),
  );

  // empty tools array is the same as omitted
  const c = buildPiArgs({ task: "x", tools: [] });
  check("empty tools array omits --tools", !c.includes("--tools"));

  // task is always the LAST positional
  const d = buildPiArgs({ task: "TASK", model: "m", systemPromptFile: "/sp" });
  check("task is the trailing arg", d[d.length - 1] === "TASK");
}

// --- parseStreamLine ---
{
  const acc = { assistantText: "", assistantTurns: 0 };

  // empty / garbled lines are no-ops
  parseStreamLine("", acc);
  parseStreamLine("   ", acc);
  parseStreamLine("not-json", acc);
  parseStreamLine("{not closed", acc);
  parseStreamLine("null", acc);
  parseStreamLine('"a string"', acc);
  check("garbled lines don't crash or accumulate", acc.assistantTurns === 0 && acc.assistantText === "");

  // unknown event type ignored
  parseStreamLine(
    JSON.stringify({ type: "tool_call_start", message: { role: "tool" } }),
    acc,
  );
  check("non-message_end event ignored", acc.assistantTurns === 0);

  // user message_end ignored (not assistant)
  parseStreamLine(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    }),
    acc,
  );
  check("user message ignored", acc.assistantTurns === 0);

  // assistant message_end with text part accumulates
  parseStreamLine(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello " }] },
    }),
    acc,
  );
  check(
    "assistant message_end accumulates text",
    acc.assistantTurns === 1 && acc.assistantText === "hello ",
  );

  // mixed content: toolCall part ignored, text part captured
  parseStreamLine(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "world" },
        ],
      },
    }),
    acc,
  );
  check(
    "multi-part assistant message: only text is captured",
    acc.assistantTurns === 2 && acc.assistantText === "hello world",
  );

  // missing content (defensive)
  parseStreamLine(
    JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
    acc,
  );
  check(
    "assistant message_end with no content is safe",
    acc.assistantTurns === 2,
    `turns: ${acc.assistantTurns}`,
  );
}

// --- resolvePiInvocation ---
{
  const r = resolvePiInvocation();
  check(
    "resolvePiInvocation returns command + args",
    typeof r.command === "string" && Array.isArray(r.args),
  );
}

// --- spawnPi end-to-end (with DI'd fake spawn) ---

class FakeStream extends EventEmitter {}
class FakeProc extends EventEmitter implements SpawnedProc {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  killSignals: string[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killSignals.push(signal);
    if (signal === "SIGKILL") this.killed = true;
    return true;
  }
}

function makeFakeSpawn(): { fn: SpawnFn; getProc: () => FakeProc | null; calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> } {
  let proc: FakeProc | null = null;
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const fn: SpawnFn = (command, args, opts) => {
    proc = new FakeProc();
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    return proc;
  };
  return { fn, getProc: () => proc, calls };
}

// happy path
{
  const { fn, getProc, calls } = makeFakeSpawn();
  const promise = spawnPi({
    cwd: "/tmp",
    task: "do thing",
    env: { PI_FLOW_SPAWN_DEPTH: "1" },
    spawnImpl: fn,
  });

  // give the spawn microtask a tick to install handlers
  await Promise.resolve();
  const proc = getProc()!;

  // emit two assistant message_ends across multiple chunks (boundary mid-line)
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "part1 " }],
      },
    }) + "\n" +
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "part2" }],
        },
      }).slice(0, 20),
  );
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "part2" }],
      },
    }).slice(20) + "\n",
  );

  // and some stderr noise
  proc.stderr.emit("data", "warn: tool x missing\n");

  // close with exit 0
  proc.emit("close", 0);

  const result = await promise;
  check("happy-path exit code", result.exitCode === 0);
  check("happy-path collected two assistant turns", result.assistantTurns === 2);
  check(
    "happy-path concatenated text spanning a chunk boundary",
    result.assistantText === "part1 part2",
    `got: ${JSON.stringify(result.assistantText)}`,
  );
  check("happy-path captured stderr", result.stderr.includes("tool x missing"));
  check("happy-path wasAborted=false", result.wasAborted === false);
  check("happy-path env propagated", calls[0]!.env.PI_FLOW_SPAWN_DEPTH === "1");
  check(
    "happy-path cwd propagated",
    calls[0]!.cwd === "/tmp",
  );
  check(
    "happy-path invocation surfaces full arg vector",
    Array.isArray(result.invocation.args) && result.invocation.args.includes("do thing"),
  );
}

// non-zero exit
{
  const { fn, getProc } = makeFakeSpawn();
  const promise = spawnPi({ cwd: ".", task: "x", spawnImpl: fn });
  await Promise.resolve();
  const proc = getProc()!;
  proc.emit("close", 17);
  const r = await promise;
  check("non-zero exit propagates", r.exitCode === 17);
  check("non-zero exit: no assistant text", r.assistantText === "");
}

// process error event → exit code 1
{
  const { fn, getProc } = makeFakeSpawn();
  const promise = spawnPi({ cwd: ".", task: "x", spawnImpl: fn });
  await Promise.resolve();
  const proc = getProc()!;
  proc.emit("error", new Error("ENOENT"));
  const r = await promise;
  check("spawn error → exit 1", r.exitCode === 1);
}

// trailing buffer (no terminating newline) is flushed on close
{
  const { fn, getProc } = makeFakeSpawn();
  const promise = spawnPi({ cwd: ".", task: "x", spawnImpl: fn });
  await Promise.resolve();
  const proc = getProc()!;
  // last line has no \n
  proc.stdout.emit(
    "data",
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "final" }] },
    }),
  );
  proc.emit("close", 0);
  const r = await promise;
  check(
    "trailing buffer flushed on close",
    r.assistantText === "final" && r.assistantTurns === 1,
  );
}

// abort signal → SIGTERM, then SIGKILL after grace
{
  const { fn, getProc } = makeFakeSpawn();
  const ctl = new AbortController();
  let scheduledDelay = -1;
  const killCbBox: { fn: (() => void) | null } = { fn: null };
  const promise = spawnPi({
    cwd: ".",
    task: "x",
    spawnImpl: fn,
    signal: ctl.signal,
    killGraceMs: 250,
    setTimeoutImpl: (cb, ms) => {
      scheduledDelay = ms;
      killCbBox.fn = cb;
      return 0;
    },
  });
  await Promise.resolve();
  const proc = getProc()!;
  ctl.abort();

  check("abort sent SIGTERM", proc.killSignals.includes("SIGTERM"));
  check("abort scheduled kill grace", scheduledDelay === 250);

  // fire the scheduled kill — process still alive (we never set killed=true on SIGTERM)
  killCbBox.fn?.();
  check("after grace, SIGKILL sent", proc.killSignals.includes("SIGKILL"));

  // child eventually closes
  proc.emit("close", 143);
  const r = await promise;
  check("aborted run reports wasAborted=true", r.wasAborted === true);
  check("aborted run exit code captured", r.exitCode === 143);
}

// pre-aborted signal kills immediately
{
  const { fn, getProc } = makeFakeSpawn();
  const ctl = new AbortController();
  ctl.abort();
  const promise = spawnPi({
    cwd: ".",
    task: "x",
    spawnImpl: fn,
    signal: ctl.signal,
    killGraceMs: 50,
    setTimeoutImpl: (cb) => {
      cb();
      return 0;
    },
  });
  await Promise.resolve();
  const proc = getProc()!;
  check("pre-aborted signal → immediate SIGTERM", proc.killSignals.includes("SIGTERM"));
  proc.emit("close", 143);
  const r = await promise;
  check("pre-aborted reports wasAborted=true", r.wasAborted === true);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
