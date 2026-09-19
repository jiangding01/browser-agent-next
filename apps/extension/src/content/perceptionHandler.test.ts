import { describe, expect, it, vi } from "vitest";
import { handlePerceptionRequest } from "./perceptionHandler.js";
import type { DomFramePerceptionSource } from "./domFrameSource.js";

describe("handlePerceptionRequest", () => {
  it("preserves request identity and returns the frame snapshot", () => {
    const scan = vi.fn(() => ({
      source: "dom" as const,
      frameEpoch: "frame-a",
      elements: [],
      coverage: {
        actionable: { status: "complete" as const, returned: 0, totalKnown: 0 },
        forms: { status: "complete" as const, returned: 0, totalKnown: 0 },
        text: {
          status: "unknown" as const,
          returned: 0 as const,
          reason: "not-scanned",
        },
      },
      openShadowRootCount: 0,
    }));

    const source = { scan } as unknown as DomFramePerceptionSource;
    const response = handlePerceptionRequest(
      source,
      {} as Document,
      {} as Window,
      {
        type: "perception.observe-dom",
        requestId: "req-1",
        options: { maxElements: 10 },
      },
    );

    expect(response).toMatchObject({
      type: "perception.observe-dom.result",
      requestId: "req-1",
      ok: true,
      snapshot: { frameEpoch: "frame-a" },
    });
    expect(scan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { maxElements: 10 },
    );
  });

  it("returns a bounded structured error", () => {
    const source = {
      scan() {
        throw new Error("x".repeat(800));
      },
    } as unknown as DomFramePerceptionSource;

    const response = handlePerceptionRequest(
      source,
      {} as Document,
      {} as Window,
      {
        type: "perception.observe-dom",
        requestId: "req-2",
      },
    );

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unexpected success");
    expect(response.error.code).toBe("DOM_PERCEPTION_FAILED");
    expect(response.error.message.length).toBe(500);
  });
});
