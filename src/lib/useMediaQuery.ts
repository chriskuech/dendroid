import { useEffect, useState } from "react";

/** Live-tracks a `matchMedia` query — same subscribe-to-`change` shape as
 * `useTheme`'s system-color-scheme listener, generalized to any query.
 * Used for the tree's <900px responsive breakpoint (comp/Dendroid
 * Screens.dc.html section "03 Tree"). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
