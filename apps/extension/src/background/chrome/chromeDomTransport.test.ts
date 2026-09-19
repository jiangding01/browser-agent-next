import { describe, expect, it, vi } from "vitest";
import { ChromeDomFrameTransport } from "./chromeDomTransport.js";

describe("ChromeDomFrameTransport", () => {
  it("targets the discovered Chrome documentId to fail closed across frame navigation", async () => {
    const sendMessage = vi.fn(async (_tabId, request: { requestId: string }) => ({
      type: "perception.observe-dom.result",
      requestId: request.requestId,
      ok: true,
      snapshot: {
        source: "dom",
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
          actionable: { status: "complete", returned: 0, totalKnown: 0 },
          forms: { status: "complete", returned: 0, totalKnown: 0 },
          text: { status: "unknown", returned: 0, reason: "not-scanned" },
        },
        openShadowRootCount: 0,
      },
    }));

    const transport = new ChromeDomFrameTransport({ sendMessage });

    await transport.send(
      9,
      {
        frameId: "web:7",
        transportFrameId: 7,
        documentId: "doc-7",
        accessible: true,
      },
      {
        type: "perception.observe-dom",
        requestId: "req-1",
      },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ requestId: "req-1" }),
      { documentId: "doc-7" },
    );
  });

  it("rejects an invalid or mismatched response envelope", async () => {
    const transport = new ChromeDomFrameTransport({
      async sendMessage() {
        return {
          type: "perception.observe-dom.result",
          requestId: "wrong",
          ok: false,
          error: {
            code: "DOM_PERCEPTION_FAILED",
            message: "failed",
          },
        };
      },
    });

    await expect(
      transport.send(
        9,
        {
          frameId: "web:0",
          transportFrameId: 0,
          documentId: "doc-main",
          accessible: true,
        },
        {
          type: "perception.observe-dom",
          requestId: "req-1",
        },
      ),
    ).rejects.toThrow(/requestId/);
  });
});
