/**
 * Smoke for B4 afk-state. Run with:
 *   bun extension/afk-state.smoke.ts
 *
 * Pure renderer + count-derivation + ticker-with-fake-interval.
 * No real /flow-afk wiring (that runs via the registered command in
 * index.ts and is exercised by the human-acceptance walkthrough on #55).
 */

import {
  renderStatusWidget,
  deriveCounts,
  makeStubTicker,
  createAfkState,
} from "./afk-state.ts";
import type { Snapshot } from "./poller.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- renderStatusWidget ---
{
  const lines = renderStatusWidget({
    afkActive: true,
    counts: {
      tracksLive: 2,
      needsAcceptance: 1,
      reviewHuman: 1,
      nextAssignable: { issue: 270, effort: "s" },
      idleMinutes: 14,
    },
  });
  check(
    "renders DESIGN.md headline shape with AFK marker",
    lines.length === 1 &&
      lines[0]!.includes("flow · AFK") &&
      lines[0]!.includes("2 tracks live") &&
      lines[0]!.includes("next: #270 (s)") &&
      lines[0]!.includes("1 needs-acceptance") &&
      lines[0]!.includes("1 review:human") &&
      lines[0]!.includes("idle 14m"),
    `line: ${lines[0]}`,
  );
}

{
  const lines = renderStatusWidget({
    afkActive: false,
    counts: {
      tracksLive: 1,
      needsAcceptance: 0,
      reviewHuman: 0,
      nextAssignable: null,
      idleMinutes: null,
    },
  });
  check(
    "no AFK marker when inactive; 'next: —' when no assignable; 'running' when active",
    lines[0]!.startsWith("flow · ") &&
      !lines[0]!.includes("AFK") &&
      lines[0]!.includes("next: —") &&
      lines[0]!.includes("running"),
    `line: ${lines[0]}`,
  );
}

{
  const lines = renderStatusWidget({
    afkActive: false,
    afkPaused: true,
    counts: {
      tracksLive: 0,
      needsAcceptance: 0,
      reviewHuman: 0,
      nextAssignable: null,
      idleMinutes: null,
    },
  });
  check(
    "afkPaused banner takes precedence",
    lines.length === 1 && lines[0] === "flow · AFK paused · /flow-afk to resume",
  );
}

{
  const lines = renderStatusWidget({
    afkActive: true,
    counts: {
      tracksLive: 1,
      needsAcceptance: 0,
      reviewHuman: 0,
      nextAssignable: { issue: 99, effort: null },
      idleMinutes: null,
    },
  });
  check(
    "1 track (singular) and no effort suffix when null",
    lines[0]!.includes("1 track live") &&
      lines[0]!.includes("next: #99 ·"),
    `line: ${lines[0]}`,
  );
}

// --- deriveCounts ---
{
  const snapshot: Snapshot = {
    issues: new Map([
      [
        1,
        {
          number: 1,
          state: "OPEN",
          labels: ["tracking", "enhancement"],
          assignees: [],
          updatedAt: "x",
        },
      ],
      [
        2,
        {
          number: 2,
          state: "OPEN",
          labels: ["tracking"],
          assignees: [],
          updatedAt: "x",
        },
      ],
      [
        3,
        {
          number: 3,
          state: "OPEN",
          labels: ["needs-acceptance", "review:human"],
          assignees: [],
          updatedAt: "x",
        },
      ],
      [
        4,
        {
          number: 4,
          // closed tracking issue must NOT count
          state: "CLOSED",
          labels: ["tracking"],
          assignees: [],
          updatedAt: "x",
        },
      ],
    ]),
    prs: new Map(),
    ts: 0,
  };
  const c = deriveCounts({
    snapshot,
    labels: {
      tracking: "tracking",
      needsAcceptance: "needs-acceptance",
      reviewHuman: "review:human",
    },
    nextAssignable: null,
    idleMinutes: null,
  });
  check("tracksLive counts only OPEN tracking issues", c.tracksLive === 2);
  check("needsAcceptance counted on OPEN issues", c.needsAcceptance === 1);
  check("reviewHuman counted on OPEN issues", c.reviewHuman === 1);
}

{
  const c = deriveCounts({
    snapshot: null,
    labels: {
      tracking: "tracking",
      needsAcceptance: "needs-acceptance",
      reviewHuman: "review:human",
    },
    nextAssignable: null,
    idleMinutes: null,
  });
  check(
    "null snapshot yields all-zero counts",
    c.tracksLive === 0 && c.needsAcceptance === 0 && c.reviewHuman === 0,
  );
}

// --- stub ticker with injected interval ---
{
  const intervalArmed: Array<{ fn: () => void; ms: number }> = [];
  let cleared = false;
  const ticker = makeStubTicker({
    cadenceMs: 1234,
    log: () => {},
    setInterval: (fn, ms) => {
      intervalArmed.push({ fn, ms });
      return "handle";
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  check("not running before start", !ticker.isRunning());
  ticker.start();
  check("running after start", ticker.isRunning());
  check(
    "setInterval invoked with cadence",
    intervalArmed.length === 1 && intervalArmed[0]!.ms === 1234,
  );
  ticker.start(); // double-start should be a no-op
  check("double-start is idempotent", ticker.isRunning());
  ticker.stop();
  check("clearInterval called on stop", cleared);
  check("not running after stop", !ticker.isRunning());
  ticker.stop(); // double-stop must not throw
  check("double-stop is idempotent", !ticker.isRunning());
}

// --- AfkState toggle ---
{
  const ticker = makeStubTicker({
    log: () => {},
    setInterval: () => "h",
    clearInterval: () => {},
  });
  const s = createAfkState(ticker);
  check("starts inactive", s.isActive() === false);
  s.setActive(true);
  check("setActive(true) flips", s.isActive() === true);
  s.setActive(false);
  check("setActive(false) flips back", s.isActive() === false);
}

// --- B5: persistence replay ---
{
  const { replayAfkEntries, deriveStartupWidget } = await import("./afk-state.ts");

  // no entries → null → not paused
  check(
    "replayAfkEntries: no entries returns null",
    replayAfkEntries([]) === null,
  );
  check(
    "deriveStartupWidget: null → not paused",
    deriveStartupWidget(null).afkPaused === false,
  );

  // ignores non-custom and other customType
  check(
    "replay ignores non-flow-afk entries",
    replayAfkEntries([
      { type: "message" },
      { type: "custom", customType: "some-other", data: { afkActive: true } },
    ]) === null,
  );

  // picks the LATEST flow-afk entry
  const r1 = replayAfkEntries([
    { type: "custom", customType: "flow-afk", data: { afkActive: true, ts: 1 } },
    { type: "custom", customType: "flow-afk", data: { afkActive: false, ts: 2 } },
  ]);
  check("replay returns the latest entry", r1?.afkActive === false);

  const r2 = replayAfkEntries([
    { type: "custom", customType: "flow-afk", data: { afkActive: false, ts: 1 } },
    { type: "custom", customType: "flow-afk", data: { afkActive: true, ts: 2 } },
  ]);
  check("latest=true → paused", deriveStartupWidget(r2).afkPaused === true);
  check("latest=false → not paused", deriveStartupWidget(r1).afkPaused === false);

  // malformed data is skipped (no afkActive boolean)
  const r3 = replayAfkEntries([
    { type: "custom", customType: "flow-afk", data: { afkActive: "yes" } },
    { type: "custom", customType: "flow-afk", data: null },
    { type: "custom", customType: "flow-afk" }, // no data
  ]);
  check("malformed entries don't crash and are ignored", r3 === null);
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
