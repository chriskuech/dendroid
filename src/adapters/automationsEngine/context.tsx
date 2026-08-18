// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { AutomationsEngineAdapter } from "./types";

const AutomationsEngineContext = createContext<AutomationsEngineAdapter>(adapter);

export function AutomationsEngineProvider({ children, value }: { children: ReactNode; value: AutomationsEngineAdapter }) {
  return <AutomationsEngineContext.Provider value={value}>{children}</AutomationsEngineContext.Provider>;
}

export function useAutomationsEngine(): AutomationsEngineAdapter {
  return useContext(AutomationsEngineContext);
}
