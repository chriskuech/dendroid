// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { AcpAdapter } from "./types";

const AcpContext = createContext<AcpAdapter>(adapter);

export function AcpProvider({ children, value }: { children: ReactNode; value: AcpAdapter }) {
  return <AcpContext.Provider value={value}>{children}</AcpContext.Provider>;
}

export function useAcp(): AcpAdapter {
  return useContext(AcpContext);
}
