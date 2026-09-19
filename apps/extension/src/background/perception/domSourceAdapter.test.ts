import { describe, expect, it } from "vitest";
import { adaptDomFrameSnapshot } from "./domSourceAdapter.js";
import type { DomFrameSnapshot } from "../../content/domFrameSource.js";

function frameSnapshot(): DomFrameSnapshot {
  return {
    source: "dom",
    frameEpoch: "frame-epoch-a",
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
        stableId: "s1",
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        geometry: {
          rect: { x: 10, y: 20, width: 100, height: 32 },
          inViewport: true,
        },
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

describe("adaptDomFrameSnapshot", () => {
  it("attaches tab/frame identity outside the content script", () => {
    const result = adaptDomFrameSnapshot({
      tabId: 7,
      frameId: "web:0",
      snapshot: frameSnapshot(),
    });

    expect(result.elements[0]).toMatchObject({
      identity: {
        source: "dom",
        tabId: 7,
        frameEpoch: "frame-epoch-a",
        stableId: "s1",
      },
      frameId: "web:0",
      semantic: { role: "button", name: "Save" },
    });
  });
});
