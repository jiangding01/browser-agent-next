import { describe, expect, it, vi } from "vitest";
import { DomFramePerceptionSource } from "./domFrameSource.js";
import { registerDomPerceptionContentListener } from "./perceptionListener.js";

describe("registerDomPerceptionContentListener", () => {
  it("ignores unrelated messages and handles typed perception requests", () => {
    let listener:
      | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void)
      | undefined;

    const runtime = {
      onMessage: {
        addListener(value: typeof listener) {
          listener = value;
        },
        removeListener: vi.fn(),
      },
    };

    const source = {
      scan() {
        return {
          source: "dom" as const,
          frameEpoch: "frame-a",
          viewport: {
            width: 100,
            height: 100,
            scrollX: 0,
            scrollY: 0,
            scrollWidth: 100,
            scrollHeight: 100,
          },
          elements: [],
          coverage: {
            actionable: { status: "complete" as const, returned: 0, totalKnown: 0 },
            forms: { status: "complete" as const, returned: 0, totalKnown: 0 },
            text: { status: "unknown" as const, returned: 0 as const, reason: "not-scanned" },
          },
          openShadowRootCount: 0,
        };
      },
    } as unknown as DomFramePerceptionSource;

    registerDomPerceptionContentListener(
      runtime,
      {} as Document,
      {} as Window,
      source,
    );

    const sendResponse = vi.fn();
    expect(listener?.({ type: "other" }, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();

    listener?.(
      { type: "perception.observe-dom", requestId: "req-1" },
      {},
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "perception.observe-dom.result",
        requestId: "req-1",
        ok: true,
      }),
    );
  });
});
