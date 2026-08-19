// Below this, the tree stops splitting the viewport with the editor and
// instead becomes a full-screen drawer over it — see comp/Dendroid
// Screens.dc.html section "03 Tree". Shared between Workspace (layout) and
// AppState (zen chrome gating — see useZenChrome.ts) so the two never
// disagree on the breakpoint.
export const NARROW_QUERY = "(max-width: 899px)";
