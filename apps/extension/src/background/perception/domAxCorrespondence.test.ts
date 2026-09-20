import { describe, expect, it } from "vitest";
import {
  linkDomAxFrames,
  linkMainFrameDomAx,
} from "./domAxCorrespondence.js";
import type { CollectedDomSource } from "./domCollector.js";
import type { CollectedAxSource } from "./axSource.js";

function dom(): CollectedDomSource {
  return {
    source: "dom",
    coverage: {
      actionable: { status: "complete", returned: 2, totalKnown: 2 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
    },
    frameEpochByFrame: {
      "web:0": "frame-main",
      "web:2": "frame-child",
    },
    viewportByFrame: {},
    elements: [
      {
        source: "dom",
        identity: {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-main",
          stableId: "s1",
        },
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
      },
      {
        source: "dom",
        identity: {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-child",
          stableId: "s2",
        },
        kind: "element",
        semantic: { role: "button", name: "Child Action" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [{ kind: "click" }],
      },
    ],
  };
}

function ax(): CollectedAxSource {
  return {
    source: "ax",
    mainCdpFrameId: "cdp-main",
    cdpFrameIdByFrame: {
      "web:0": "cdp-main",
      "web:2": "cdp-child",
    },
    coverage: {
      actionable: { status: "complete", returned: 2, totalKnown: 2 },
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
          documentEpoch: "doc-main",
          backendNodeId: 42,
        },
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
      },
      {
        source: "ax",
        identity: {
          source: "ax",
          tabId: 7,
          cdpFrameId: "cdp-child",
          documentEpoch: "doc-child",
          backendNodeId: 84,
        },
        kind: "element",
        semantic: { role: "button", name: "Child Action" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [{ kind: "click" }],
      },
    ],
  };
}

describe("linkDomAxFrames", () => {
  it("main + child 都必须由 resolver 证明 backend node ↔ stableId 后才生成 mergeKey", async () => {
    const linked = await linkDomAxFrames({
      tabId: 7,
      dom: dom(),
      ax: ax(),
      resolver: {
        async stableIdsForBackendNodes({ cdpFrameId }) {
          return cdpFrameId === "cdp-main"
            ? new Map([[42, "s1"]])
            : new Map([[84, "s2"]]);
        },
      },
    });

    expect(linked.linkedCount).toBe(2);
    expect(linked.dom.elements[0]?.mergeKey).toBe(
      "backend:cdp-main:doc-main:42",
    );
    expect(linked.dom.elements[1]?.mergeKey).toBe(
      "backend:cdp-child:doc-child:84",
    );
  });

  it("semantic 完全相同但 resolver 无映射时保持独立 identity", async () => {
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
