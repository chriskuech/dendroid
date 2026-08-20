// Regression coverage for `applyUpdate`'s unwrapping of the raw
// `session/update` notification shape — a mismatch here previously meant
// every `sessionUpdate` fell through to the `default:` case silently, so an
// agent's replies streamed in over the wire but never appeared in the chat
// timeline (see `src-acp/tests/roundtrip.rs` for the real wire shape this
// mirrors: `params` is `{sessionId, update: {sessionUpdate, ...}}`, not the
// inner `update` object flattened to the top level).

import { describe, expect, it } from "vitest";
import { applyUpdate } from "./timelineUpdates";

describe("applyUpdate", () => {
  it("unwraps a raw session/update notification's params (sessionId + update)", () => {
    const timeline = applyUpdate([], {
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    });

    expect(timeline).toEqual([expect.objectContaining({ kind: "message", role: "agent", text: "hi", streaming: true })]);
  });

  it("still accepts an already-unwrapped update object", () => {
    const timeline = applyUpdate([], { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });

    expect(timeline).toEqual([expect.objectContaining({ kind: "message", role: "agent", text: "hi", streaming: true })]);
  });
});
