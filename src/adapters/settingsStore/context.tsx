// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows: the context's default is already the
// real, platform-selected adapter, so `SettingsStoreProvider` only needs
// mounting in a test that wants to override it.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { SettingsStoreAdapter } from "./types";

const SettingsStoreContext = createContext<SettingsStoreAdapter>(adapter);

export function SettingsStoreProvider({ children, value }: { children: ReactNode; value: SettingsStoreAdapter }) {
  return <SettingsStoreContext.Provider value={value}>{children}</SettingsStoreContext.Provider>;
}

export function useSettingsStore(): SettingsStoreAdapter {
  return useContext(SettingsStoreContext);
}
