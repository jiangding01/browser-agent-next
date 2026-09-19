import { describe, expect, it } from "vitest";
import { collectDomSource } from "./domCollector.js";
import type { DomFrameSnapshot } from "../../content/domFrameSource.js";

function snapshot(
  frameEpoch: string,
  stableId: string,
): DomFrameSnapshot {
  return {
    source: "dom",
    frameEpoch,
    elements: [
      {
        stableId,
        kind: "element",
        semantic: { role: "button", name: stableId },
        state: { visible: true, enabled: true, focused: false },
        capabilities: [{ kind: "click" }],
      },
    ],
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0, reason: "not-scanned" },
    },
    openShadowRootCount: 0,
  };
}

describe("collectDomSource", () => {
  it("aggregates disjoint frame results", async () => {
    const result = await collectDomSource({
      tabId: 7,
      requestId: "obs",
      frames: [
        { frameId: "main", accessible: true },
        { frameId: "child", accessible: true },
      ],
      transport: {
        async send(_tabId, frameId, request) {
          return {
            type: "perception.observe-dom.result",
            requestId: request.requestId,
            ok: true,
            snapshot: snapshot("epoch-" + frameId, "s-" + frameId),
          };
        },
      },
    });

    expect(result.elements).toHaveLength(2);
    expect(result.coverage.actionable).toEqual({
      status: "complete",
      returned: 2,
      totalKnown: 2,
    });
  });

  it("degrades coverage instead of hiding an inaccessible frame", async () => {
    const result = await collectDomSource({
      tabId: 7,
      requestId: "obs",
      frames: [
        { frameId: "main", accessible: true },
        { frameId: "child", accessible: false },
      ],
      transport: {
        async send(_tabId, _frameId, request) {
          return {
            type: "perception.observe-dom.result",
            requestId: request.requestId,
            ok: true,
            snapshot: snapshot("epoch-main", "s-main"),
          };
        },
      },
    });

    expect(result.coverage.actionable.status).toBe("partial");
    expect(result.degradedFrames).toEqual(["child"]);
  });
});
