// See `adapters/dialog/context.tsx` for the pattern this (and every other
// adapter's `context.tsx`) follows.

import { createContext, useContext, type ReactNode } from "react";
import { adapter } from "./index";
import type { MaterializeAdapter } from "./types";

const MaterializeContext = createContext<MaterializeAdapter>(adapter);

export function MaterializeProvider({ children, value }: { children: ReactNode; value: MaterializeAdapter }) {
  return <MaterializeContext.Provider value={value}>{children}</MaterializeContext.Provider>;
}

export function useMaterialize(): MaterializeAdapter {
  return useContext(MaterializeContext);
}
