import { describe, expect, test } from "bun:test";
import type { RunResult } from "@pi-flow/flow-engine";
import type { FlowdConfig } from "../src/config.ts";
import { type DaemonDeps, runDaemon } from "../src/daemon.ts";
import type { DaemonHeartbeat } from "../src/status.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal FlowdConfig — the daemon only forwards it to tickFn, so any
 * valid-shape object works here.
 */
const FAKE_CONFIG: FlowdConfig = {
  repo: "owner/repo",
  defaultBranch: "main",
  trackBranch: "track/5",
  workdir: "/tmp/fake",
  actor: "bot",
  aiDisclaimer: "AI-generated",
  reviewerIterationCap: 3,
  verifyCommand: "echo ok",
  credentialsPath: "/tmp/creds.json",
  models: {
    implement: { provider: "anthropic", id: "claude-opus" },
    review: { provider: "anthropic", id: "claude-haiku" },
    slice: { provider: "anthropic", id: "claude-haiku" },
    planReview: { provider: "anthropic", id: "claude-haiku" },
  },
};

const IDLE_RESULT: RunResult = { steps: [], outcome: "fixpoint" };

const WORK_RESULT: RunResult = {
  steps: [{ action: "implement", sliceId: 42 }],
  outcome: "fixpoint",
};

const WORK_RESULT_WITH_DETAIL: RunResult = {
  steps: [{ action: "merge", sliceId: 7, detail: "merged PR #99" }],
  outcome: "fixpoint",
};

/** Build a deps object with safe defaults, overriding only what the test needs. */
function makeDeps(overrides: Partial<DaemonDeps>): DaemonDeps {
  return {
    tickFn: async () => IDLE_RESULT,
    writeHeartbeat: async () => {},
    sleep: async () => {},
    now: () => 1_000_000,
    pollCadenceMs: 60_000,
    log: () => {},
    ...overrides,
  };
}

// ── tick → heartbeat → sleep cadence ─────────────────────────────────────────

describe("runDaemon — tick/heartbeat/sleep ordering", () => {
  test("calls tickFn, then writeHeartbeat, then sleep — in order per tick", async () => {
    const events: string[] = [];
    const ac = new AbortController();
    let tick = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          events.push("tick");
          tick++;
          // Abort during the second tick so the loop runs exactly twice.
          if (tick >= 2) ac.abort();
          return IDLE_RESULT;
        },
        writeHeartbeat: async () => {
          events.push("heartbeat");
        },
        sleep: async () => {
          events.push("sleep");
        },
      }),
      ac.signal,
    );

    // First full iteration: tick → heartbeat → sleep
    expect(events.slice(0, 3)).toEqual(["tick", "heartbeat", "sleep"]);
    // Second iteration: tick (abort fires) → heartbeat → no sleep (stopping)
    expect(events[3]).toBe("tick");
    expect(events[4]).toBe("heartbeat");
    // Total heartbeat count = 2 in-loop + 1 final shutdown
    expect(events.filter((e) => e === "heartbeat").length).toBe(3);
  });

  test("sleeps with the configured poll cadence", async () => {
    const sleepMs: number[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        pollCadenceMs: 12_345,
        writeHeartbeat: async () => {
          ac.abort();
        },
        sleep: async (ms) => {
          sleepMs.push(ms);
        },
      }),
      ac.signal,
    );

    // Sleep is not reached because stopping=true before it (abort fires in writeHeartbeat).
    // Run one more iteration without aborting in writeHeartbeat to capture a sleep.
    const sleepMs2: number[] = [];
    const ac2 = new AbortController();
    let hbCount = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        pollCadenceMs: 12_345,
        writeHeartbeat: async () => {
          hbCount++;
          // Abort on the second heartbeat (after one sleep has been recorded)
          if (hbCount >= 2) ac2.abort();
        },
        sleep: async (ms) => {
          sleepMs2.push(ms);
        },
      }),
      ac2.signal,
    );

    expect(sleepMs2[0]).toBe(12_345);
  });
});

// ── heartbeat content ─────────────────────────────────────────────────────────

describe("runDaemon — heartbeat content", () => {
  test("idle tick → activity is 'fixpoint—sleeping'", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => IDLE_RESULT,
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          ac.abort();
        },
      }),
      ac.signal,
    );

    expect(heartbeats[0]).toMatchObject({
      activity: "fixpoint—sleeping",
      consecutiveErrors: 0,
      pid: process.pid,
    });
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(typeof heartbeats[0]!.lastTickAt).toBe("string");
  });

  test("work tick → activity describes the last step", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => WORK_RESULT,
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          ac.abort();
        },
      }),
      ac.signal,
    );

    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[0]!.activity).toBe("implement #42");
  });

  test("work tick with detail → activity includes detail", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => WORK_RESULT_WITH_DETAIL,
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          ac.abort();
        },
      }),
      ac.signal,
    );

    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[0]!.activity).toBe("merge #7 — merged PR #99");
  });

  test("heartbeat is written once per tick (in-loop) plus a final shutdown", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();
    let tick = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tick++;
          if (tick >= 2) ac.abort();
          return IDLE_RESULT;
        },
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
        },
      }),
      ac.signal,
    );

    // 2 in-loop writes + 1 final shutdown = 3
    expect(heartbeats.length).toBe(3);
    // biome-ignore lint/style/noNonNullAssertion: array indices are safe in test
    expect(heartbeats[0]!.activity).toBe("fixpoint—sleeping");
    // biome-ignore lint/style/noNonNullAssertion: array indices are safe in test
    expect(heartbeats[1]!.activity).toBe("fixpoint—sleeping");
    // biome-ignore lint/style/noNonNullAssertion: array indices are safe in test
    expect(heartbeats[2]!.activity).toBe("shutdown");
  });
});

// ── graceful shutdown ─────────────────────────────────────────────────────────

describe("runDaemon — graceful shutdown", () => {
  test("abort during sleep: finishes current tick cleanly then exits", async () => {
    const ac = new AbortController();
    let tickCount = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tickCount++;
          return IDLE_RESULT;
        },
        sleep: async () => {
          // Fire abort signal during the sleep — daemon should stop after this.
          ac.abort();
        },
      }),
      ac.signal,
    );

    // Exactly one tick ran; the abort during sleep prevented a second tick.
    expect(tickCount).toBe(1);
  });

  test("abort during tickFn: loop exits without another tick", async () => {
    const ac = new AbortController();
    let tickCount = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tickCount++;
          ac.abort();
          return IDLE_RESULT;
        },
      }),
      ac.signal,
    );

    expect(tickCount).toBe(1);
  });

  test("writes a final shutdown heartbeat on stop", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          ac.abort();
        },
      }),
      ac.signal,
    );

    const last = heartbeats.at(-1);
    // biome-ignore lint/style/noNonNullAssertion: array is non-empty by test construction
    expect(last!.activity).toBe("shutdown");
    // biome-ignore lint/style/noNonNullAssertion: array is non-empty by test construction
    expect(last!.pid).toBe(process.pid);
  });

  test("resolves (does not hang) after signal", async () => {
    const ac = new AbortController();
    ac.abort(); // abort before the loop even starts

    // Should resolve immediately without running any ticks.
    await runDaemon(FAKE_CONFIG, 5, makeDeps({}), ac.signal);
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe("runDaemon — error handling", () => {
  test("tick error increments consecutiveErrors and continues the loop", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();
    let tick = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tick++;
          if (tick === 1) throw new Error("boom");
          return IDLE_RESULT;
        },
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          if (tick >= 2) ac.abort();
        },
      }),
      ac.signal,
    );

    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[0]!.consecutiveErrors).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[0]!.activity).toContain("error:");
  });

  test("consecutiveErrors resets to 0 after a successful tick", async () => {
    const heartbeats: DaemonHeartbeat[] = [];
    const ac = new AbortController();
    let tick = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tick++;
          if (tick === 1) throw new Error("transient");
          return IDLE_RESULT;
        },
        writeHeartbeat: async (hb) => {
          heartbeats.push(hb);
          if (tick >= 2) ac.abort();
        },
      }),
      ac.signal,
    );

    // First heartbeat: after the failing tick
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[0]!.consecutiveErrors).toBe(1);
    // Second heartbeat: after the successful tick — counter reset
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(heartbeats[1]!.consecutiveErrors).toBe(0);
  });

  test("heartbeat failure does not halt the loop", async () => {
    const ac = new AbortController();
    let tickCount = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          tickCount++;
          if (tickCount >= 2) ac.abort();
          return IDLE_RESULT;
        },
        // Always throws — the loop must swallow it and continue.
        writeHeartbeat: async () => {
          throw new Error("disk full");
        },
      }),
      ac.signal,
    );

    expect(tickCount).toBe(2);
  });
});

// ── structured log ────────────────────────────────────────────────────────────

describe("runDaemon — structured log", () => {
  test("emits a log line per tick with track, outcome, steps, activity, ts", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => IDLE_RESULT,
        writeHeartbeat: async () => {
          ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    expect(logs[0]).toMatchObject({
      track: 5,
      outcome: "fixpoint",
      steps: 0,
      activity: "fixpoint—sleeping",
    });
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(typeof logs[0]!.ts).toBe("string");
  });

  test("log line for a working tick shows steps > 0 and correct activity", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => WORK_RESULT,
        writeHeartbeat: async () => {
          ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    expect(logs[0]).toMatchObject({
      track: 5,
      outcome: "fixpoint",
      steps: 1,
      activity: "implement #42",
    });
  });

  test("log line for an error tick includes consecutiveErrors and error fields", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: async () => {
          throw new Error("network timeout");
        },
        writeHeartbeat: async () => {
          ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    expect(logs[0]).toMatchObject({
      track: 5,
      outcome: "error",
      consecutiveErrors: 1,
    });
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(String(logs[0]!.error)).toContain("network timeout");
  });
});

// ── idempotent resume ─────────────────────────────────────────────────────────

describe("runDaemon — idempotent resume", () => {
  test("re-entering after stop re-derives state from tickFn — no duplicate actions", async () => {
    // The daemon is stateless between runs: it calls tickFn every tick and
    // tickFn re-derives the next action from scratch.  Two separate daemon
    // runs with the same tickFn must produce the same call sequence (no
    // leftover state from the first run contaminates the second).
    const calls1: number[] = [];
    const calls2: number[] = [];

    const makeTickFn =
      (log: number[]) =>
      async (_cfg: FlowdConfig, trackId: number): Promise<RunResult> => {
        log.push(trackId);
        return IDLE_RESULT;
      };

    const ac1 = new AbortController();
    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: makeTickFn(calls1),
        writeHeartbeat: async () => {
          ac1.abort();
        },
      }),
      ac1.signal,
    );

    const ac2 = new AbortController();
    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        tickFn: makeTickFn(calls2),
        writeHeartbeat: async () => {
          ac2.abort();
        },
      }),
      ac2.signal,
    );

    // Both runs received the same trackId — the daemon carries no state between runs.
    expect(calls1).toEqual([5]);
    expect(calls2).toEqual([5]);
  });
});

// ── NEEDS YOU log-on-entry ────────────────────────────────────────────────────

describe("runDaemon — NEEDS YOU log-on-entry", () => {
  test("logs needsYou once when an item first enters the set", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        needsYouFn: async () => [{ id: 42, title: "Review it", reason: "ready-for-human" }],
        writeHeartbeat: async () => {
          ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    const needsYouLogs = logs.filter((l) => l.needsYou !== undefined);
    expect(needsYouLogs).toHaveLength(1);
    expect(needsYouLogs[0]).toMatchObject({
      track: 5,
      needsYou: 42,
      reason: "ready-for-human",
    });
    // biome-ignore lint/style/noNonNullAssertion: array index is safe in test
    expect(String(needsYouLogs[0]!.message)).toContain("🔔 NEEDS YOU #42");
  });

  test("does NOT re-log the same item on the next tick", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();
    let tick = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        needsYouFn: async () => [{ id: 42, title: "Review it", reason: "ready-for-human" }],
        tickFn: async () => {
          tick++;
          return IDLE_RESULT;
        },
        writeHeartbeat: async () => {
          // Let two ticks complete before stopping
          if (tick >= 2) ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    // Two ticks ran but the needs-you item must only appear once
    expect(tick).toBeGreaterThanOrEqual(2);
    const needsYouLogs = logs.filter((l) => l.needsYou !== undefined);
    expect(needsYouLogs).toHaveLength(1);
  });

  test("logs each distinct item exactly once across multiple ticks", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();
    let tick = 0;

    // First tick: two items; second tick: same two items; third tick: a new third item
    const responses = [
      [
        { id: 10, title: "A", reason: "needs-triage" },
        { id: 11, title: "B", reason: "needs-grilling" },
      ],
      [
        { id: 10, title: "A", reason: "needs-triage" },
        { id: 11, title: "B", reason: "needs-grilling" },
      ],
      [
        { id: 10, title: "A", reason: "needs-triage" },
        { id: 11, title: "B", reason: "needs-grilling" },
        { id: 12, title: "C", reason: "needs-acceptance" },
      ],
    ];

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        needsYouFn: async () => responses[Math.min(tick - 1, responses.length - 1)] ?? [],
        tickFn: async () => {
          tick++;
          return IDLE_RESULT;
        },
        writeHeartbeat: async () => {
          if (tick >= 3) ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
      }),
      ac.signal,
    );

    const needsYouLogs = logs.filter((l) => l.needsYou !== undefined);
    // Items 10 and 11 logged on tick 1; item 12 logged on tick 3; no repeats
    expect(needsYouLogs).toHaveLength(3);
    expect(needsYouLogs.map((l) => l.needsYou)).toEqual([10, 11, 12]);
  });

  test("needsYouFn throwing does not halt the daemon", async () => {
    const ac = new AbortController();
    let tickCount = 0;

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        needsYouFn: async () => {
          throw new Error("classifier failure");
        },
        tickFn: async () => {
          tickCount++;
          return IDLE_RESULT;
        },
        writeHeartbeat: async () => {
          if (tickCount >= 2) ac.abort();
        },
      }),
      ac.signal,
    );

    // Loop continued despite the classification error
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  test("absent needsYouFn is a no-op (no needs-you log lines)", async () => {
    const logs: Record<string, unknown>[] = [];
    const ac = new AbortController();

    await runDaemon(
      FAKE_CONFIG,
      5,
      makeDeps({
        writeHeartbeat: async () => {
          ac.abort();
        },
        log: (line) => {
          logs.push(line);
        },
        // needsYouFn intentionally absent
      }),
      ac.signal,
    );

    expect(logs.filter((l) => l.needsYou !== undefined)).toHaveLength(0);
  });
});
