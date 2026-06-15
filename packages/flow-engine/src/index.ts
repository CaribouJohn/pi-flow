/**
 * `@pi-flow/flow-engine` — the framework-free Flow engine.
 *
 * The stateless reducer over (tracker + git) described in `docs/SPEC.md`. It
 * stays free of any CLI, UI, or framework imports (ADR-0016) so a CLI, a daemon,
 * or the dashboard can each bind to it. Real adapters and the in-memory fakes
 * implement the ports in `ports.ts`.
 */
export const FLOW_ENGINE_VERSION = "0.0.0";

export * from "./domain.ts";
export * from "./derive.ts";
export * from "./ports.ts";
export * from "./orchestrator.ts";
export * from "./plan-review.ts";
export * from "./slice-plan.ts";
