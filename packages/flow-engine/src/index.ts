/**
 * `@pi-flow/flow-engine` — the framework-free Flow engine.
 *
 * This package is the stateless reducer over (tracker + git) described in
 * `docs/SPEC.md`. It must stay free of any CLI, UI, or framework imports
 * (ADR-0016) so a CLI, a daemon, or the dashboard can each bind to it.
 *
 * The walking-skeleton (#79) lands the real surface across later slices:
 * the adapter interfaces and the S0–S8 reducer arrive in #82. For now this is
 * a placeholder so the toolchain (#80) has something to type-check and test.
 */
export const FLOW_ENGINE_VERSION = "0.0.0";
