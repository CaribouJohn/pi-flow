import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { DashboardRPC } from "../../shared/rpc";

// The Bun side of the RPC seam (#206). Mirrors Hiss's src/bun/index.ts window +
// RPC-handler wiring, stripped to the shell: define the typed RPC, register the
// single `ping` handler, open ONE BrowserWindow pointed at the bundled webview.
const rpc = BrowserView.defineRPC<DashboardRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      // The whole proof: the webview calls ping() on mount and renders this
      // string. If it shows up, the window opened (DPI), the webview loaded
      // (CSP), and the RPC socket round-tripped.
      ping: () => ({ message: "flowd dashboard — RPC alive" }),
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
