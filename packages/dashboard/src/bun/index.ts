import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type StatusConfig, fetchBoardSnapshot } from "@pi-flow/flowd-cli";
import { loadConfig } from "@pi-flow/flowd-cli/config";
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { DashboardRPC } from "../../shared/rpc";

// The Bun side of the RPC seam. #206 was the shell (ping only); #208 adds the
// read-only board data plane: getBoard (live snapshot) + openTicket (external
// click-through). The webview talks ONLY to this loopback socket; GitHub is
// opened in the OS browser here, never fetched by the webview.

const CONFIG_FILENAME = "flowd.config.json";

/**
 * Resolve the repo root by walking up from a set of start directories looking
 * for `flowd.config.json`. CRITICAL: the dashboard's runtime cwd under
 * `electrobun dev` is NOT the repo root, but the config + credentials + git
 * workdir are all repo-root-relative. We probe process.cwd() and this module's
 * directory (the bundled bun entry may live deep under the repo) and walk to the
 * filesystem root. Returns null if no config is found anywhere above us.
 */
function findRepoRoot(): string | null {
  const starts = new Set<string>();
  starts.add(process.cwd());
  try {
    starts.add(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // import.meta.url may be unavailable in some bundling modes; cwd suffices.
  }

  for (const start of starts) {
    let dir = start;
    // Walk up to the filesystem root.
    while (true) {
      if (existsSync(resolve(dir, CONFIG_FILENAME))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break; // reached the root
      dir = parent;
    }
  }
  return null;
}

/** A clear, webview-renderable error (never crashes the process). */
class BoardError extends Error {}

/**
 * Load the flowd config from the repo root and shape the minimal
 * {@link StatusConfig} for `fetchBoardSnapshot`, resolving credentialsPath +
 * workdir to ABSOLUTE paths so gh/git I/O works regardless of the dashboard's
 * runtime cwd.
 */
async function loadStatusConfig(): Promise<{ config: StatusConfig; heartbeatPath: string }> {
  const root = findRepoRoot();
  if (root === null) {
    throw new BoardError(
      `could not find ${CONFIG_FILENAME} — start the dashboard from inside the pi-flow repo`,
    );
  }
  const configPath = resolve(root, CONFIG_FILENAME);
  let full: Awaited<ReturnType<typeof loadConfig>>;
  try {
    full = await loadConfig(configPath);
  } catch (err) {
    throw new BoardError(
      `could not load ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const credentialsPath = isAbsolute(full.credentialsPath)
    ? full.credentialsPath
    : resolve(root, full.credentialsPath);
  if (!existsSync(credentialsPath)) {
    throw new BoardError(
      `forge credentials not found at ${credentialsPath} — create .flowd/credentials.json`,
    );
  }
  const workdir = isAbsolute(full.workdir) ? full.workdir : resolve(root, full.workdir);

  const config: StatusConfig = {
    repo: full.repo,
    workdir,
    defaultBranch: full.defaultBranch,
    credentialsPath,
  };
  // Heartbeat is operator-local under .flowd/; resolve against the repo root.
  const heartbeatPath = resolve(root, ".flowd", "daemon-heartbeat.json");
  return { config, heartbeatPath };
}

/** Open a URL in the OS default browser (Windows-first, like the rest). */
function openInBrowser(url: string): void {
  if (process.platform === "win32") {
    // `cmd /c start "" <url>` — the empty "" is the (ignored) window title so a
    // quoted URL isn't mistaken for it. detached/unref so we don't hold the app.
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

const rpc = BrowserView.defineRPC<DashboardRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      ping: () => ({ message: "flowd dashboard — RPC alive" }),

      // Live board snapshot. Errors are thrown (the RPC layer rejects the
      // promise) so the webview can render a clear message — we never crash.
      getBoard: async () => {
        const { config, heartbeatPath } = await loadStatusConfig();
        return await fetchBoardSnapshot(config, { heartbeatPath });
      },

      // External click-through: open the ticket URL in the OS browser.
      // Defense-in-depth: the webview only ever sends ticketUrl(repo, id) =
      // https://github.com/<repo>/issues/<n> (repo from trusted config, id a
      // number), but the Bun handler must not trust the webview blindly — it
      // feeds the OS `start`/`open` shell. Reject anything that isn't a GitHub
      // https URL before it reaches that shell.
      openTicket: ({ url }) => {
        if (!/^https:\/\/github\.com\//.test(url)) {
          throw new Error(`openTicket: refusing to open non-GitHub URL: ${url}`);
        }
        openInBrowser(url);
        return undefined;
      },
    },
    messages: {},
  },
});

const mainWindow = new BrowserWindow({
  title: "flowd dashboard",
  url: "views://mainview/index.html",
  frame: { width: 1000, height: 700, x: 100, y: 100 },
  rpc,
});

mainWindow.on("close", () => process.exit(0));

console.log("flowd dashboard started");
