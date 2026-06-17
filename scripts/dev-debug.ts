// Launch the dashboard dev app with the WebView2 remote-debugging port enabled,
// so a CDP client (e.g. the electrobun-dev skill) can attach. This is the ONLY
// thing that differs from `dev`: it sets WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// (a WebView2-runtime env var) then delegates to the package's `dev` script.
// Run via `bun run --filter dashboard dev:debug`. Windows/WebView2 only.
//
// Mirrors Hiss's scripts/dev-debug.ts. It runs `bun run dev` in the CURRENT
// working directory, which under `bun run --filter dashboard dev:debug` is the
// dashboard package dir — so the right `dev` script (vite build && electrobun
// dev) is invoked.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const port = process.env.CDP_PORT ?? "9222";
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
};
// Pre-clean: a previous run left orphaned / forcibly-killed will hold the CDP
// port and segfault this launch. stop-debug.ts is idempotent (no-op when clean).
console.log("[dev:debug] pre-cleaning any prior instance...");
spawnSync("bun", ["run", join(import.meta.dir, "stop-debug.ts")], { stdio: "inherit", env });
console.log(`[dev:debug] launching with WebView2 CDP on :${port}`);
const r = spawnSync("bun", ["run", "dev"], { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 0);
