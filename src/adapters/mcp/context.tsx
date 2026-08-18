// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { McpAdapter } from "./types";

const McpContext = createContext<McpAdapter>(adapter);

export function McpProvider({ children, value }: { children: ReactNode; value: McpAdapter }) {
  return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}

export function useMcp(): McpAdapter {
  return useContext(McpContext);
}
