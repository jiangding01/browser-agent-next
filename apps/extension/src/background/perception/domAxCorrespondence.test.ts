import { describe, expect, it } from "vitest";
import { linkMainFrameDomAx } from "./domAxCorrespondence.js";
import type { CollectedDomSource } from "./domCollector.js";
import type { CollectedAxSource } from "./axSource.js";

function dom(): CollectedDomSource {
  return {
    source: "dom",
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
    },
    frameEpochByFrame: { "web:0": "frame-a" },
    viewportByFrame: {},
    elements: [
      {
        source: "dom",
        identity: {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-a",
          stableId: "s1",
        },
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
      },
    ],
  };
}

function ax(): CollectedAxSource {
  return {
    source: "ax",
    mainCdpFrameId: "cdp-main",
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
    },
    elements: [
      {
        source: "ax",
        identity: {
          source: "ax",
          tabId: 7,
          cdpFrameId: "cdp-main",
          documentEpoch: "chrome-document:doc-a",
          backendNodeId: 42,
        },
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
      },
    ],
  };
}

describe("linkMainFrameDomAx", () => {
  it("只有 resolver 证明 backend node 对应 stableId 后才生成 mergeKey", async () => {
    const linked = await linkMainFrameDomAx({
      tabId: 7,
      mainFrameId: "web:0",
      dom: dom(),
      ax: ax(),
      resolver: {
        async stableIdsForBackendNodes() {
          return new Map([[42, "s1"]]);
        },
      },
    });

    expect(linked.linkedCount).toBe(1);
    expect(linked.dom.elements[0]?.mergeKey).toBe(
      "backend:cdp-main:chrome-document:doc-a:42",
    );
    expect(linked.ax.elements[0]?.mergeKey).toBe(
      linked.dom.elements[0]?.mergeKey,
    );
  });

  it("semantic 完全相同但 resolver 无映射时仍保持两个独立 identity", async () => {
    const linked = await linkMainFrameDomAx({
      tabId: 7,
      mainFrameId: "web:0",
      dom: dom(),
      ax: ax(),
      resolver: {
        async stableIdsForBackendNodes() {
          return new Map();
        },
      },
    });

    expect(linked.linkedCount).toBe(0);
    expect(linked.dom.elements[0]?.mergeKey).toBeUndefined();
    expect(linked.ax.elements[0]?.mergeKey).toBeUndefined();
  });
});
