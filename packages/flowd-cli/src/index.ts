#!/usr/bin/env bun
import { planInvocation } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { runFlow } from "./flow-run.ts";

const plan = planInvocation(process.argv.slice(2));
if (plan.kind === "usage") {
  console.error(plan.message);
  process.exit(plan.code);
}

const configPath = plan.config ?? process.env.FLOWD_CONFIG ?? "flowd.config.json";
try {
  const config = await loadConfig(configPath);
  const result = await runFlow(config, plan.track);
  for (const step of result.steps) {
    const detail = step.detail !== undefined ? ` — ${step.detail}` : "";
    console.log(`  ${step.action} #${step.sliceId}${detail}`);
  }
  const parked = result.parkedReason !== undefined ? ` (${result.parkedReason})` : "";
  console.log(`outcome: ${result.outcome}${parked}`);
  process.exit(result.outcome === "fixpoint" ? 0 : 1);
} catch (err) {
  console.error("flowd run failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
