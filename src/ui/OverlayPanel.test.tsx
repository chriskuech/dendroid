// Covers the shared drawer shell's own resize wiring (the `resize` prop)
// in isolation — AgentPanel.test.tsx exercises the same handle indirectly
// as part of its full chat-drawer suite, but the drag math and min/max
// clamping only need to be proven once, against the shell itself.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OverlayPanel } from "./OverlayPanel";

describe("OverlayPanel", () => {
  it("renders no resize handle when `resize` isn't given (e.g. the tree drawer)", () => {
    render(
      <OverlayPanel side="left" open onOpenChange={vi.fn()} title="Tree">
        <div>content</div>
      </OverlayPanel>,
    );
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("renders the dimming backdrop by default", () => {
    render(
      <OverlayPanel side="right" open onOpenChange={vi.fn()} title="Agent chat">
        <div>content</div>
      </OverlayPanel>,
    );
    expect(document.querySelector(".overlay-panel__backdrop")).toBeInTheDocument();
  });

  it("skips the dimming backdrop when `dim` is false, so the rest of the page stays interactive", () => {
    render(
      <OverlayPanel side="right" open onOpenChange={vi.fn()} title="Agent chat" dim={false}>
        <div>content</div>
      </OverlayPanel>,
    );
    expect(document.querySelector(".overlay-panel__backdrop")).not.toBeInTheDocument();
  });

  it("dragging a right-anchored drawer's handle left grows it, and commits on release", () => {
    const onResize = vi.fn();
    render(
      <OverlayPanel
        side="right"
        open
        onOpenChange={vi.fn()}
        title="Agent chat"
        resize={{ width: 320, min: 280, max: 560, onResize }}
      >
        <div>content</div>
      </OverlayPanel>,
    );
    const handle = screen.getByRole("separator");

    // side="right" is anchored to the right edge — dragging the pointer
    // left (toward the page) should grow it, not shrink it.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onResize).toHaveBeenCalledWith(360);
  });

  it("dragging a left-anchored drawer's handle right grows it", () => {
    const onResize = vi.fn();
    render(
      <OverlayPanel side="left" open onOpenChange={vi.fn()} title="Tree" resize={{ width: 280, min: 220, max: 480, onResize }}>
        <div>content</div>
      </OverlayPanel>,
    );
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onResize).toHaveBeenCalledWith(330);
  });

  it("clamps to the given min/max", () => {
    const onResize = vi.fn();
    render(
      <OverlayPanel
        side="right"
        open
        onOpenChange={vi.fn()}
        title="Agent chat"
        resize={{ width: 320, min: 280, max: 560, onResize }}
      >
        <div>content</div>
      </OverlayPanel>,
    );
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -5000 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onResize).toHaveBeenCalledWith(560);
  });
});
