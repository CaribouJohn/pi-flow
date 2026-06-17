#!/usr/bin/env bun
// PRE-build step: embed a DPI-aware application manifest into the bun.exe TEMPLATE
// that Electrobun copies into every bundle, so the packaged app gets a DPI-aware
// host. Mirrors Hiss's scripts/embed-manifest.ts.
//
// Why bun.exe needs this: it is Electrobun's host process — it owns the OS window
// and calls CreateCoreWebView2Controller (via libNativeWrapper.dll). bun ships a
// manifest with NO dpiAware token, and a WebView2 runtime update (149.0.4022.52,
// 2026-06) began rejecting controller creation from a DPI-UNAWARE process with
// HRESULT 0x8007139F (ERROR_INVALID_STATE) -> blank window + a segfault. See Hiss
// docs/adr/0035-dpi-aware-host-manifest.md.
//
// NOTE (#206): this only runs in the `build` script — NOT in `dev`. A `dev` launch
// uses the unpatched template, so a DPI-unaware blank window is possible in dev on
// affected WebView2 runtimes. Windows-only (rcedit-x64.exe); no-ops elsewhere.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rcedit } from "rcedit";

if (process.platform !== "win32") {
  console.log("embed-manifest: skipped (not win32)");
  process.exit(0);
}

const root = join(import.meta.dir, "..");
const manifestPath = join(root, "packages", "dashboard", "bun-host-dpi.manifest");
if (!existsSync(manifestPath)) {
  console.error(`embed-manifest: ${manifestPath} not found`);
  process.exit(1);
}

// Electrobun's bundled bun.exe template — the source `electrobun build` copies into
// the bundle. Resolve via the dashboard symlink first, then the bun store fallback.
const candidates = [
  join(root, "packages", "dashboard", "node_modules", "electrobun", "dist-win-x64", "bun.exe"),
  ...new Bun.Glob(
    "node_modules/.bun/electrobun@*/node_modules/electrobun/dist-win-x64/bun.exe",
  ).scanSync({ cwd: root, absolute: true }),
];
const template = candidates.find((p) => existsSync(p));
if (template === undefined) {
  console.error("embed-manifest: could not locate electrobun's dist-win-x64/bun.exe template");
  process.exit(1);
}

// Pull the embedded <assembly>...</assembly> manifest text out of a PE by scanning
// its bytes — enough to introspect dpi/base tokens without parsing PE resources.
function readEmbeddedManifest(exePath: string): string | null {
  const text = readFileSync(exePath).toString("latin1");
  const start = text.indexOf("<assembly");
  if (start < 0) return null;
  const end = text.indexOf("</assembly>", start);
  if (end < 0) return null;
  return text.slice(start, end + "</assembly>".length);
}

// The base settings our snapshot (bun-host-dpi.manifest) carries over from bun's
// own manifest. If bun stops shipping these, replacing its manifest wholesale would
// silently drop them — so refuse and ask for a re-snapshot instead.
const BASE_MARKERS = ["longPathAware", "SegmentHeap"];

const current = readEmbeddedManifest(template);
if (current === null) {
  console.error(`embed-manifest: could not read an embedded manifest from ${template} — aborting`);
  process.exit(1);
}
if (current.includes("dpiAware")) {
  console.log(`embed-manifest: ${template} already DPI-aware — skipping`);
  process.exit(0);
}
const missing = BASE_MARKERS.filter((m) => !current.includes(m));
if (missing.length > 0) {
  console.error(
    `embed-manifest: bun.exe's manifest no longer contains [${missing.join(", ")}]. bun likely changed its manifest; re-snapshot it into bun-host-dpi.manifest before patching (replacing it now would drop those settings). Aborting.`,
  );
  process.exit(1);
}

const before = statSync(template).size;
await rcedit(template, { "application-manifest": manifestPath });
const after = statSync(template).size;

// Confirm the patch took — fail the build rather than ship a still-broken host.
const patched = readEmbeddedManifest(template);
if (patched === null || !patched.includes("dpiAware")) {
  console.error(`embed-manifest: rcedit ran but ${template} is still not DPI-aware — aborting`);
  process.exit(1);
}
console.log(`embed-manifest: set DPI-aware manifest on ${template} (${before} -> ${after} bytes)`);
