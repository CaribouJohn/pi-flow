#!/usr/bin/env bun
import { runCalibrate } from "./calibrate.ts";
import { planInvocation } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { runPlan } from "./flow-plan.ts";
import { rejectTrack } from "./flow-reject.ts";
import { runFlow } from "./flow-run.ts";

const plan = planInvocation(process.argv.slice(2));
if (plan.kind === "usage") {
  console.error(plan.message);
  process.exit(plan.code);
}

const configPath = plan.config ?? process.env.FLOWD_CONFIG ?? "flowd.config.json";

// calibrate is read-only and works without a full config (falls back gracefully).
if (plan.kind === "calibrate") {
  let calibrateConfig: import("./cost-estimator.ts").CostEstimatorConfig | undefined;
  let historyPath = ".flowd/cost-history.jsonl";
  try {
    const cfg = await loadConfig(configPath);
    calibrateConfig = cfg.costEstimator;
    if (cfg.costMeter) historyPath = cfg.costMeter.historyPath;
  } catch {
    // config absent or invalid — proceed with defaults
  }
  const report = await runCalibrate({ historyPath, config: calibrateConfig });
  console.log(report);
  process.exit(0);
}

try {
  const config = await loadConfig(configPath);

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
