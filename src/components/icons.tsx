// 1px, non-antialiased pixel icons on a 16x16 grid — see comp/Dendroid
// Design System.dc.html section 02. Never scale to a non-integer multiple
// of 16; shape-rendering:crispEdges only stays sharp at integer zoom.

import type { SVGProps } from "react";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "viewBox" | "shapeRendering"> {
  size?: number;
}

function PixelIcon({ size = 16, fill = "currentColor", children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill={fill}
      shapeRendering="crispEdges"
      style={{ display: "block", flex: "none" }}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function LogoIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={8} y={1} width={1} height={3} />
      <rect x={4} y={4} width={9} height={1} />
      <rect x={4} y={5} width={1} height={3} />
      <rect x={12} y={5} width={1} height={3} />
      <rect x={2} y={8} width={5} height={1} />
      <rect x={10} y={8} width={5} height={1} />
      <rect x={2} y={9} width={1} height={3} />
      <rect x={6} y={9} width={1} height={3} />
      <rect x={10} y={9} width={1} height={3} />
      <rect x={14} y={9} width={1} height={3} />
    </PixelIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={4} y={4} width={1} height={1} />
      <rect x={5} y={5} width={1} height={1} />
      <rect x={6} y={6} width={1} height={1} />
      <rect x={7} y={7} width={2} height={2} />
      <rect x={9} y={9} width={1} height={1} />
      <rect x={10} y={10} width={1} height={1} />
      <rect x={11} y={11} width={1} height={1} />
      <rect x={11} y={4} width={1} height={1} />
      <rect x={10} y={5} width={1} height={1} />
      <rect x={9} y={6} width={1} height={1} />
      <rect x={6} y={9} width={1} height={1} />
      <rect x={5} y={10} width={1} height={1} />
      <rect x={4} y={11} width={1} height={1} />
    </PixelIcon>
  );
}

export function ConfirmIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={4} y={8} width={1} height={1} />
      <rect x={5} y={9} width={1} height={1} />
      <rect x={6} y={10} width={1} height={1} />
      <rect x={7} y={9} width={1} height={1} />
      <rect x={8} y={8} width={1} height={1} />
      <rect x={9} y={7} width={1} height={1} />
      <rect x={10} y={6} width={1} height={1} />
      <rect x={11} y={5} width={1} height={1} />
    </PixelIcon>
  );
}

export function IncrementIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={3} y={7} width={10} height={1} />
      <rect x={7} y={3} width={1} height={10} />
    </PixelIcon>
  );
}

export function DecrementIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={3} y={7} width={10} height={1} />
    </PixelIcon>
  );
}

/** Right-pointing disclosure chevron — rotate 90deg via CSS for the
 * expanded state (see `.tree-row__chevron`, `.heading-fold-toggle`). */
export function ChevronIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={6} y={4} width={1} height={1} />
      <rect x={7} y={5} width={1} height={1} />
      <rect x={8} y={6} width={1} height={1} />
      <rect x={9} y={7} width={1} height={1} />
      <rect x={9} y={8} width={1} height={1} />
      <rect x={8} y={9} width={1} height={1} />
      <rect x={7} y={10} width={1} height={1} />
      <rect x={6} y={11} width={1} height={1} />
    </PixelIcon>
  );
}

/** Box around a node — "set root" from comp/Dendroid Design System.dc.html
 * section 02. Doubles as the current-root indicator (the boxed tree row,
 * the editor's end-of-heading toggle) since it's literally a box around a
 * node. */
export function RerootIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={3} y={3} width={10} height={1} />
      <rect x={3} y={12} width={10} height={1} />
      <rect x={3} y={4} width={1} height={8} />
      <rect x={12} y={4} width={1} height={8} />
      <rect x={7} y={7} width={2} height={2} />
    </PixelIcon>
  );
}

export function SyncProviderIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={2} y={3} width={12} height={1} />
      <rect x={2} y={12} width={12} height={1} />
      <rect x={2} y={4} width={1} height={8} />
      <rect x={13} y={4} width={1} height={8} />
      <rect x={5} y={6} width={6} height={1} />
      <rect x={5} y={9} width={6} height={1} />
    </PixelIcon>
  );
}

export function EncryptionIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={7} y={3} width={2} height={1} />
      <rect x={6} y={4} width={1} height={1} />
      <rect x={9} y={4} width={1} height={1} />
      <rect x={6} y={5} width={1} height={2} />
      <rect x={9} y={5} width={1} height={2} />
      <rect x={4} y={7} width={8} height={1} />
      <rect x={4} y={13} width={8} height={1} />
      <rect x={4} y={8} width={1} height={5} />
      <rect x={11} y={8} width={1} height={5} />
      <rect x={7} y={9} width={2} height={2} />
    </PixelIcon>
  );
}

export function QrKeyIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={2} y={2} width={4} height={1} />
      <rect x={2} y={5} width={4} height={1} />
      <rect x={2} y={3} width={1} height={2} />
      <rect x={5} y={3} width={1} height={2} />
      <rect x={10} y={2} width={4} height={1} />
      <rect x={10} y={5} width={4} height={1} />
      <rect x={10} y={3} width={1} height={2} />
      <rect x={13} y={3} width={1} height={2} />
      <rect x={2} y={10} width={4} height={1} />
      <rect x={2} y={13} width={4} height={1} />
      <rect x={2} y={11} width={1} height={2} />
      <rect x={5} y={11} width={1} height={2} />
      <rect x={8} y={2} width={1} height={1} />
      <rect x={8} y={4} width={1} height={1} />
      <rect x={7} y={7} width={1} height={1} />
      <rect x={9} y={8} width={1} height={1} />
      <rect x={12} y={7} width={1} height={1} />
      <rect x={2} y={8} width={1} height={1} />
      <rect x={4} y={8} width={1} height={1} />
      <rect x={10} y={10} width={1} height={1} />
      <rect x={12} y={12} width={1} height={1} />
      <rect x={8} y={12} width={1} height={1} />
      <rect x={14} y={14} width={1} height={1} />
    </PixelIcon>
  );
}

/** Three-node mini-graph — comp/Dendroid Design System.dc.html section 02,
 * labeled "graph". Reserved for the mindmap tab (see comp/whitepaper.md's
 * "Graph" section) — a node at top connected by pixel-stepped diagonals to
 * two nodes at bottom-left/bottom-right. */
export function GraphIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={7} y={2} width={2} height={2} />
      <rect x={2} y={8} width={2} height={2} />
      <rect x={12} y={8} width={2} height={2} />
      <rect x={7} y={4} width={1} height={1} />
      <rect x={6} y={5} width={1} height={1} />
      <rect x={5} y={6} width={1} height={1} />
      <rect x={4} y={7} width={1} height={1} />
      <rect x={8} y={4} width={1} height={1} />
      <rect x={9} y={5} width={1} height={1} />
      <rect x={10} y={6} width={1} height={1} />
      <rect x={11} y={7} width={1} height={1} />
    </PixelIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <rect x={2} y={4} width={12} height={1} />
      <rect x={2} y={11} width={12} height={1} />
      <rect x={5} y={3} width={3} height={3} />
      <rect x={8} y={10} width={3} height={3} />
    </PixelIcon>
  );
}
