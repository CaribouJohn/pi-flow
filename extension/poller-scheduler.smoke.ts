/**
 * Smoke for the B3 poller scheduler. Run with:
 *   bun extension/poller-scheduler.smoke.ts
 *
 * Drives the scheduler with a fake clock + manual tick advance to
 * verify cadence boundaries, stop semantics, diff fan-out, and error
 * isolation — no real timers, no real gh.
 */

import {
  createPoller,
  FAST_CADENCE_MS,
  SLOW_CADENCE_MS,
  FAST_WINDOW_MS,
  type SchedulerClock,
} from "./poller-scheduler.ts";
import type { PollDeps } from "./poller.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

/**
 * Fake clock: caller controls `now`. Scheduled tasks accumulate; calling
 * `flushDue()` runs every task whose delay has elapsed.
 */
function makeFakeClock() {
  let now = 0;
  type Task = { runAt: number; fn: () => void; cancelled: boolean };
  const tasks: Task[] = [];

  const clock: SchedulerClock = {
    now: () => now,
    schedule(fn, ms) {
      const t: Task = { runAt: now + ms, fn, cancelled: false };
      tasks.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
    },
    set(t: number) {
      now = t;
    },
    /** Run every due, non-cancelled task in order. New tasks scheduled
     *  during the flush ARE picked up if they are also due. */
    async flushDue() {
      let progress = true;
      while (progress) {
        progress = false;
        tasks.sort((a, b) => a.runAt - b.runAt);
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]!;
          if (t.cancelled) continue;
          if (t.runAt > now) continue;
          t.cancelled = true; // one-shot
          progress = true;
          t.fn();
          // Allow any await chains inside fn to flush.
          await Promise.resolve();
          await Promise.resolve();
        }
      }
    },
    pendingCount() {
      return tasks.filter((t) => !t.cancelled).length;
    },
  };
}

/** Run-stub that returns canned empty JSON. */
function makeEmptyRun(): PollDeps {
  return {
    run: async () => ({
      stdout: "[]",
      stderr: "",
      code: 0,
    }),
  };
}

const labels = ["ready-for-agent", "review:human"];

// --- first tick fires immediately on start ---
{
  const fc = makeFakeClock();
  let tickCount = 0;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff(() => {
    tickCount++;
  });
  poller.start();
  await fc.flushDue();
  check("first tick fires immediately", tickCount === 1);
  poller.stop();
}

// --- subsequent ticks honour SLOW cadence when not blocked ---
{
  const fc = makeFakeClock();
  let tickCount = 0;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff(() => {
    tickCount++;
  });
  poller.start();
  await fc.flushDue(); // tick 1

  fc.advance(SLOW_CADENCE_MS - 1);
  await fc.flushDue();
  check("no tick before SLOW cadence elapses", tickCount === 1);

  fc.advance(1);
  await fc.flushDue(); // tick 2
  check("tick 2 at SLOW cadence boundary", tickCount === 2);
  poller.stop();
}

// --- FAST cadence while inside the blocked window ---
{
  const fc = makeFakeClock();
  let tickCount = 0;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff(() => {
    tickCount++;
  });
  poller.setBlockedSince(0); // blocked from t=0
  poller.start();
  await fc.flushDue(); // tick 1

  fc.advance(FAST_CADENCE_MS);
  await fc.flushDue();
  check("FAST cadence ticks within blocked window", tickCount === 2);

  // Cross the boundary — next interval should be SLOW.
  fc.set(FAST_WINDOW_MS + 1);
  await fc.flushDue(); // pending task at runAt = FAST_CADENCE_MS*2 is due
  // We'll just take whatever ticked and then verify next interval is slow.
  const beforeCross = tickCount;
  fc.advance(FAST_CADENCE_MS); // 15s past the boundary
  await fc.flushDue();
  check(
    "after FAST window, next interval is NOT 15s (SLOW cadence)",
    tickCount === beforeCross,
  );
  fc.advance(SLOW_CADENCE_MS);
  await fc.flushDue();
  check(
    "SLOW tick fires once the slow interval elapses",
    tickCount > beforeCross,
  );
  poller.stop();
}

// --- setBlockedSince(null) reverts to SLOW ---
{
  const fc = makeFakeClock();
  let tickCount = 0;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff(() => {
    tickCount++;
  });
  poller.setBlockedSince(0);
  poller.start();
  await fc.flushDue(); // tick 1 (immediate)
  poller.setBlockedSince(null); // unblock — next tick should be SLOW
  fc.advance(FAST_CADENCE_MS);
  await fc.flushDue();
  check("FAST tick suppressed after unblock", tickCount === 1);
  fc.advance(SLOW_CADENCE_MS - FAST_CADENCE_MS);
  await fc.flushDue();
  check("SLOW tick fires after unblock", tickCount === 2);
  poller.stop();
}

// --- stop() halts subsequent ticks; idempotent ---
{
  const fc = makeFakeClock();
  let tickCount = 0;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff(() => {
    tickCount++;
  });
  poller.start();
  await fc.flushDue(); // tick 1
  poller.stop();
  fc.advance(SLOW_CADENCE_MS * 10);
  await fc.flushDue();
  check("no ticks after stop", tickCount === 1);
  poller.stop(); // second stop must not throw
  check("double-stop is idempotent", true);
  check("no pending tasks after stop", fc.pendingCount() === 0);
}

// --- diff handlers receive the diffs array (empty allowed) ---
{
  const fc = makeFakeClock();
  let received: number | null = null;
  const poller = createPoller({
    pollDeps: makeEmptyRun(),
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onDiff((diffs) => {
    received = diffs.length;
  });
  poller.start();
  await fc.flushDue();
  check("handler called with empty diffs on initial tick", received === 0);
  poller.stop();
}

// --- gh error reaches onError handlers and does NOT halt scheduling ---
{
  const fc = makeFakeClock();
  let errors = 0;
  let ticks = 0;
  let first = true;
  const deps: PollDeps = {
    run: async () => {
      if (first) {
        first = false;
        return { stdout: "", stderr: "boom", code: 1 };
      }
      return { stdout: "[]", stderr: "", code: 0 };
    },
  };
  const poller = createPoller({
    pollDeps: deps,
    pollOpts: { labels },
    clock: fc.clock,
  });
  poller.onError(() => {
    errors++;
  });
  poller.onDiff(() => {
    ticks++;
  });
  poller.start();
  await fc.flushDue(); // tick 1 errors
  check("error reaches onError handler", errors === 1);
  check("no diff fired on error tick", ticks === 0);
  fc.advance(SLOW_CADENCE_MS);
  await fc.flushDue(); // tick 2 succeeds
  check("scheduler continues after error", ticks === 1);
  poller.stop();
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
