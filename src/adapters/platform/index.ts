import { hasTauriBridge } from "../detectPlatform";
import type { DocBackend } from "./types";

/**
 * Picks (and lazily loads) whichever backend this build is actually
 * running under: the Tauri IPC bridge when there's one to talk to
 * (`tauri.ts`), or otherwise the `dendroid-web` wasm module (`wasm.ts`),
 * backed by a real user-picked directory via the File System Access API.
 * Each is a dynamic import, so a Tauri build never pulls in the wasm
 * binary and a plain web build never pulls in `@tauri-apps/api`.
 *
 * Returns `null` if neither is usable — e.g. `vite dev` opened in a plain
 * browser before `bun run build:wasm` has produced `src-web/pkg` yet.
 * Callers (`lib/crdt/document.ts`) fall back to an in-memory, unpersisted
 * document in that case rather than failing outright.
 */
export async function createDocBackend(): Promise<DocBackend | null> {
  if (hasTauriBridge()) {
    const { TauriDocBackend } = await import("./tauri");
    return new TauriDocBackend();
  }

  try {
    const { WasmDocBackend } = await import("./wasm");
    return new WasmDocBackend();
  } catch (err) {
    console.warn(
      "[platform] wasm backend unavailable (has `bun run build:wasm` been run?) — falling back to an in-memory, unpersisted document.",
      err,
    );
    return null;
  }
}
