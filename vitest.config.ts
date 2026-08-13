import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts on purpose: the app config's wasm /
// top-level-await plugins exist to bundle `src-web/pkg` (wasm-pack output
// that only exists after `bun run build:wasm`), which tests never need —
// every test here either exercises pure TS/ProseMirror logic or mounts a
// `DendroidDocument` in its unpersisted, backend-less fallback mode (see
// `lib/crdt/document.ts`'s `open()` — `createDocBackend()` swallows the
// "no wasm package built" case itself). Keeping this config wasm-free means
// `bun run test` never depends on that build step having run first.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
