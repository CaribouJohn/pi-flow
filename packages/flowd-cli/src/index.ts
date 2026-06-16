#!/usr/bin/env bun
import { readCostRecordsFromGit, runCalibrate, runCalibrateFromRecords } from "./calibrate.ts";
import { planInvocation } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { runDaemon, writeHeartbeatToPath } from "./daemon.ts";
import { acceptTrack } from "./flow-accept.ts";
import { runPlan } from "./flow-plan.ts";
import { rejectTrack } from "./flow-reject.ts";
import { runFlow } from "./flow-run.ts";
import { runStatus } from "./status.ts";

const plan = planInvocation(process.argv.slice(2));
if (plan.kind === "usage") {
  console.error(plan.message);
  process.exit(plan.code);
}

const configPath = plan.config ?? process.env.FLOWD_CONFIG ?? "flowd.config.json";

// calibrate is read-only and works with or without a full config.
if (plan.kind === "calibrate") {
  try {
    const config = await loadConfig(configPath).catch(() => undefined);
    if (config?.workdir && config?.trackBranch && config?.costMeter) {
      // Primary path: read from the committed track branch (the source of
      // truth the meter writes to).  `workdir` is the managed clone where
      // the meter committed the file; `origin/<trackBranch>` carries it.
      const records = await readCostRecordsFromGit(
        config.workdir,
        config.trackBranch,
        config.costMeter.historyPath,
      );
      runCalibrateFromRecords(records, config.costEstimator);
    } else {
      // Fallback: no full config — read from the local filesystem path.
      const historyPath = config?.costMeter?.historyPath ?? ".flowd/cost-history.jsonl";
      await runCalibrate(historyPath, config?.costEstimator);
    }
  } catch (err) {
    console.error("flowd calibrate failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
}

try {
  const config = await loadConfig(configPath);

  if (plan.kind === "accept") {
    const result = await acceptTrack({ track: plan.track, config });
    if (!result.ready) {
      console.error("not ready — the following slices are still open:");
      for (const reason of result.notReadyReasons ?? []) console.error(`  ${reason}`);
      process.exit(1);
    }
    const action = result.created ? "opened" : "updated";
    console.log(`pr: #${result.prNumber} (${action})`);
    process.exit(0);
  }

  if (plan.kind === "reject") {
    const result = await rejectTrack({ track: plan.track, reason: plan.reason, config });
    console.log(`corrective: #${result.correctiveId}`);
    if (result.acceptanceId !== undefined) {
      console.log(`acceptance: #${result.acceptanceId} (kept open)`);
    }
    process.exit(0);
  }

  if (plan.kind === "plan") {
    const result = await runPlan({ issue: plan.issue, prdPath: plan.prd, config });
    console.log(`parent: #${plan.issue}`);
    console.log(`slices: ${result.childIds.map((id) => `#${id}`).join(", ")}`);
    console.log(`acceptance: #${result.acceptanceId ?? "?"}`);
    console.log(`gate: ${result.gate}`);
    if (result.risks.length > 0) {
      console.log("risks:");
      for (const risk of result.risks) console.log(`  - ${risk}`);
    }
    if (result.costEstimate) console.log(`cost: ${result.costEstimate}`);
    process.exit(result.gate === "clear" ? 0 : 1);
  }

  if (plan.kind === "daemon") {
    await runDaemon(config, plan.track, {
      tickFn: runFlow,
      writeHeartbeat: writeHeartbeatToPath,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    process.exit(0);
  }

  if (plan.kind === "status") {
    const summary = await runStatus({
      repo: config.repo,
      workdir: config.workdir,
      defaultBranch: config.defaultBranch,
      credentialsPath: config.credentialsPath,
    });
    console.log(summary);
    process.exit(0);
  }

  // plan.kind === "run"
  const result = await runFlow(config, plan.track);
  for (const step of result.steps) {
    const detail = step.detail !== undefined ? ` — ${step.detail}` : "";
    console.log(`  ${step.action} #${step.sliceId}${detail}`);
  }
  const parked = result.parkedReason !== undefined ? ` (${result.parkedReason})` : "";
  console.log(`outcome: ${result.outcome}${parked}`);
  process.exit(result.outcome === "fixpoint" ? 0 : 1);
} catch (err) {
  console.error("flowd failed:", err instanceof Error ? err.message : String(err));
  // Bun.$ ShellError carries the command's stderr/stdout — surface it, otherwise
  // a failed git/gh command is just an opaque "exit code N".
  const shell = err as { stderr?: { toString(): string }; stdout?: { toString(): string } };
  const stderr = shell.stderr?.toString().trim();
  const stdout = shell.stdout?.toString().trim();
  if (stderr) console.error(stderr);
  else if (stdout) console.error(stdout);
  process.exit(1);
}
