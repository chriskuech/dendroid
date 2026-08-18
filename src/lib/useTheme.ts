import { useEffect, useState } from "react";
import type { Aesthetic, ColorMode } from "./types";

function resolveMode(colorMode: ColorMode, systemPrefersDark: boolean): "dark" | "light" {
  if (colorMode === "system") return systemPrefersDark ? "dark" : "light";
  return colorMode;
}

/** Applies [data-aesthetic]/[data-mode]/[data-system-font] to <html> and keeps
 * "system" in sync with the OS color scheme. See src/theme.css for the
 * palettes and font tokens. */
export function useTheme(aesthetic: Aesthetic, colorMode: ColorMode, useSystemFont: boolean) {
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const mode = resolveMode(colorMode, systemPrefersDark);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-aesthetic", aesthetic);
    root.setAttribute("data-mode", mode);
    root.toggleAttribute("data-system-font", useSystemFont);
  }, [aesthetic, mode, useSystemFont]);

  return mode;
}
