import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The React webview build (mirrors Hiss's vite.config.ts). Roots at src/mainview,
// emits dist/index.html which electrobun.config.ts copies into views/mainview/.
export default defineConfig({
  plugins: [react()],
  root: "src/mainview",
  base: "./",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      shared: path.resolve(__dirname, "shared"),
    },
  },
  server: { port: 5174, strictPort: true },
});
