// Drag math + commit timing only — the two call sites (Sidebar.tsx,
// OverlayPanel.tsx) each have their own tests covering the handle's actual
// DOM wiring and CSS-facing behavior.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useResizableWidth } from "./useResizableWidth";

function pointerEvent(clientX: number, overrides: Partial<ReactPointerEvent<Element>> = {}): ReactPointerEvent<Element> {
  return {
    button: 0,
    clientX,
    pointerId: 1,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false },
    ...overrides,
  } as ReactPointerEvent<Element>;
}

describe("useResizableWidth", () => {
  it("tracks a live width during drag without calling onResize", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizableWidth({ width: 280, min: 200, max: 400, edge: "end", onResize }));

    act(() => result.current.handleProps.onPointerDown(pointerEvent(100)));
    act(() => result.current.handleProps.onPointerMove(pointerEvent(140)));

    expect(result.current.width).toBe(320);
    expect(result.current.isDragging).toBe(true);
    expect(onResize).not.toHaveBeenCalled();
  });

  it("commits the final width once, on pointerup", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizableWidth({ width: 280, min: 200, max: 400, edge: "end", onResize }));

    act(() => result.current.handleProps.onPointerDown(pointerEvent(100)));
    act(() => result.current.handleProps.onPointerMove(pointerEvent(140)));
    act(() => result.current.handleProps.onPointerUp(pointerEvent(140)));

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(320);
    expect(result.current.width).toBe(280);
    expect(result.current.isDragging).toBe(false);
  });

  it("clamps to min/max", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizableWidth({ width: 280, min: 200, max: 400, edge: "end", onResize }));

    act(() => result.current.handleProps.onPointerDown(pointerEvent(100)));
    act(() => result.current.handleProps.onPointerMove(pointerEvent(1000)));
    act(() => result.current.handleProps.onPointerUp(pointerEvent(1000)));

    expect(onResize).toHaveBeenCalledWith(400);
  });

  it("inverts the delta for a 'start' edge (handle on the panel's leading edge)", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizableWidth({ width: 320, min: 280, max: 560, edge: "start", onResize }));

    // Dragging left (negative dx) grows a "start"-edge panel.
    act(() => result.current.handleProps.onPointerDown(pointerEvent(200)));
    act(() => result.current.handleProps.onPointerMove(pointerEvent(150)));
    act(() => result.current.handleProps.onPointerUp(pointerEvent(150)));

    expect(onResize).toHaveBeenCalledWith(370);
  });

  it("does nothing on pointerup without a preceding pointerdown", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizableWidth({ width: 280, min: 200, max: 400, edge: "end", onResize }));

    act(() => result.current.handleProps.onPointerUp(pointerEvent(140)));

    expect(onResize).not.toHaveBeenCalled();
  });
});
