import type { ElectrobunConfig } from "electrobun/bun";

// App config (mirrors Hiss's electrobun.config.ts, stripped to the shell). The
// Bun entrypoint is src/bun/index.ts; the vite-built dist/index.html + assets
// are copied into views/mainview/ so the window's views://mainview/index.html
// URL resolves. No native DLLs, no icon pipeline yet (later slices).
export default {
  app: {
    name: "flowd-dashboard",
    identifier: "dev.flowd.dashboard",
    version: "0.0.0",
  },
  build: {
    useAsar: true,
    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },
    views: {},
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets/": "views/mainview/assets/",
    },
    // Electrobun's default asarUnpack; kept explicit for parity with Hiss.
    asarUnpack: ["*.exe", "*.node", "*.dll", "*.dylib", "*.so"],
    watchIgnore: ["dist/**"],
    mac: { codesign: false, notarize: false, bundleCEF: false, entitlements: {} },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  release: { baseUrl: "" },
} satisfies ElectrobunConfig;
