import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // wasm(): loads wasm-bindgen output (e.g. from `src-web`) as ES modules.
  // topLevelAwait(): wasm-bindgen's glue code awaits instantiation at
  // module scope, which needs this to bundle for targets without native
  // top-level await.
  plugins: [react(), wasm(), topLevelAwait()],

  build: {
    // vite-plugin-top-level-await re-lowers its output to whatever
    // `build.target` resolves to; left unset, that's Vite's own default
    // (a multi-browser esbuild target list), and esbuild can't lower
    // destructuring for that combination — a known interaction bug
    // between the two. Both runtimes this app ships to (Tauri's WebView,
    // and any browser modern enough to have OPFS for the web build) fully
    // support top-level await natively, so there's nothing to lower for.
    target: "esnext",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
