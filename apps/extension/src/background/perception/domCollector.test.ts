import { describe, expect, it } from "vitest";
import { collectDomSource } from "./domCollector.js";
import type { DomFrameSnapshot } from "../../content/domFrameSource.js";

function snapshot(
  frameEpoch: string,
  stableId: string,
  origin = "https://fixture.test",
): DomFrameSnapshot {
  return {
    source: "dom",
    frameEpoch,
    origin,
    viewport: {
      width: 100,
      height: 100,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 100,
      scrollHeight: 100,
    },
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
  it("aggregates disjoint frame results and keeps frame epochs", async () => {
    const result = await collectDomSource({
      tabId: 7,
      requestId: "obs",
      frames: [
        { frameId: "web:0", transportFrameId: 0, documentId: "doc-main", accessible: true },
        { frameId: "web:7", transportFrameId: 7, documentId: "doc-child", accessible: true },
      ],
      transport: {
        async send(_tabId, target, request) {
          return {
            type: "perception.observe-dom.result",
            requestId: request.requestId,
            ok: true,
            snapshot: snapshot("epoch-" + target.frameId, "s-" + target.frameId),
          };
        },
      },
    });

    expect(result.elements).toHaveLength(2);
    expect(result.frameEpochByFrame).toEqual({
      "web:0": "epoch-web:0",
      "web:7": "epoch-web:7",
    });
    expect(result.originByFrame).toEqual({
      "web:0": "https://fixture.test",
      "web:7": "https://fixture.test",
    });
    expect(result.coverage.actionable).toEqual({
      status: "complete",
      returned: 2,
      totalKnown: 2,
    });
  });

  it("keeps opaque origins and records malformed or missing reports as opaque", async () => {
    const reported: Record<string, unknown> = {
      "web:0": "https://fixture.test",
      "web:1": "null",
      "web:2": "https://fixture.test/path",
      "web:3": 42,
      "web:4": undefined,
    };
    const result = await collectDomSource({
      tabId: 7,
      requestId: "obs",
      frames: Object.keys(reported).map((frameId, index) => ({
        frameId,
        transportFrameId: index,
        documentId: "doc-" + index,
        accessible: true,
      })),
      transport: {
        async send(_tabId, target, request) {
          return {
            type: "perception.observe-dom.result",
            requestId: request.requestId,
            ok: true,
            snapshot: {
              ...snapshot("epoch-" + target.frameId, "s-" + target.frameId),
              origin: reported[target.frameId] as string,
            },
          };
        },
      },
    });

    expect(result.originByFrame).toEqual({
      "web:0": "https://fixture.test",
      "web:1": "null",
      "web:2": "null",
      "web:3": "null",
      "web:4": "null",
    });
  });

  it("degrades coverage instead of hiding an inaccessible frame", async () => {
    const result = await collectDomSource({
      tabId: 7,
      requestId: "obs",
      frames: [
        { frameId: "web:0", transportFrameId: 0, documentId: "doc-main", accessible: true },
        { frameId: "web:7", transportFrameId: 7, accessible: false },
      ],
      transport: {
        async send(_tabId, _target, request) {
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
    expect(result.degradedFrames).toEqual(["web:7"]);
  });
});
