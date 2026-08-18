/**
 * The one canonical check for whether this build is running inside Tauri
 * (with its native IPC bridge to talk to) versus a plain web build (a
 * browser tab, `vite dev` opened directly, ...). Every adapter domain's
 * `index.ts` uses this to pick which implementation to construct — see
 * that domain's own `context.tsx` for how the result reaches React as a
 * hook, and this file's own history for why it's worth centralizing:
 * before, seven different files each kept their own copy of this same
 * one-line check.
 */
export function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
