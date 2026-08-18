// The React-facing half of this adapter: `index.ts` already picked the
// right implementation for the running platform, so this just hands that
// choice to components as context — a component reaching for `useDialog()`
// never needs to import `tauri.ts`/`web.ts` itself, or know which one is
// live. The context's default *is* the real, platform-selected adapter, so
// nothing needs to mount `DialogProvider` in the running app; it exists so
// a test can override it with a fake `DialogAdapter` instead.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { DialogAdapter } from "./types";

const DialogContext = createContext<DialogAdapter>(adapter);

export function DialogProvider({ children, value }: { children: ReactNode; value: DialogAdapter }) {
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export function useDialog(): DialogAdapter {
  return useContext(DialogContext);
}
