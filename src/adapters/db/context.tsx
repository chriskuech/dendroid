// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { DbAdapter } from "./types";

const DbContext = createContext<DbAdapter>(adapter);

export function DbProvider({ children, value }: { children: ReactNode; value: DbAdapter }) {
  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
}

export function useDb(): DbAdapter {
  return useContext(DbContext);
}
