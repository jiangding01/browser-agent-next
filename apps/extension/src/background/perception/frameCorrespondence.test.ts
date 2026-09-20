import { describe, expect, it } from "vitest";
import { mapDomFramesToCdp } from "./frameCorrespondence.js";
import type { CollectedDomSource } from "./domCollector.js";

function dom(): CollectedDomSource {
  return {
    source: "dom",
    coverage: {
      actionable: { status: "complete", returned: 0, totalKnown: 0 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
    },
    elements: [],
    frameEpochByFrame: {
      "web:0": "epoch-main",
      "web:2": "epoch-child",
    },
    viewportByFrame: {},
  };
}

function rootTransport(frameTree: unknown) {
  return {
    async attach() {},
    async waitForChildSessionInitialization() {},
    childSessions() {
      return [];
    },
    async send(_tabId: number, method: string) {
      if (method !== "Page.getFrameTree") {
        throw new Error("unexpected method: " + method);
      }
      return { frameTree };
    },
    async sendInSession() {
      throw new Error("unexpected child session command");
    },
  };
}

describe("mapDomFramesToCdp", () => {
  it("只通过 frameEpoch 建立 webNavigation ↔ root CDP exact mapping", async () => {
    const correspondence = await mapDomFramesToCdp({
      tabId: 7,
      frames: [
        {
          frameId: "web:0",
          documentEpoch: "doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          parentFrameId: "web:0",
          documentEpoch: "doc-child",
          accessible: true,
        },
      ],
      dom: dom(),
      transport: rootTransport({
        frame: { id: "cdp-main" },
        childFrames: [
          { frame: { id: "cdp-child" } },
        ],
      }) as never,
      resolver: {
        async frameEpochForCdpFrame({ cdpFrameId, cdpSessionId }) {
          expect(cdpSessionId).toBeUndefined();
          return cdpFrameId === "cdp-main"
            ? "epoch-main"
            : cdpFrameId === "cdp-child"
              ? "epoch-child"
              : undefined;
        },
      },
    });

    expect(correspondence.mappings).toEqual([
      {
        webFrameId: "web:0",
        cdpFrameId: "cdp-main",
        frameEpoch: "epoch-main",
        documentEpoch: "doc-main",
      },
      {
        webFrameId: "web:2",
        cdpFrameId: "cdp-child",
        frameEpoch: "epoch-child",
        documentEpoch: "doc-child",
      },
    ]);
    expect(correspondence.unmappedWebFrameIds).toEqual([]);
  });

  it("OOPIF 只在 child flat session 内由 frameEpoch 建立 exact mapping", async () => {
    const sent: Array<{
      sessionId: string;
      method: string;
    }> = [];

    const correspondence = await mapDomFramesToCdp({
      tabId: 7,
      frames: [
        {
          frameId: "web:0",
          documentEpoch: "doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          parentFrameId: "web:0",
          documentEpoch: "doc-child",
          accessible: true,
        },
      ],
      dom: dom(),
      transport: {
        async attach() {},
        async waitForChildSessionInitialization() {},
        childSessions() {
          return [{
            sessionId: "session-child",
            targetId: "target-child",
            targetType: "iframe",
          }];
        },
        async send(_tabId: number, method: string) {
          if (method !== "Page.getFrameTree") {
            throw new Error("unexpected root method");
          }
          return {
            frameTree: {
              frame: { id: "cdp-main" },
            },
          };
        },
        async sendInSession(
          _tabId: number,
          sessionId: string,
          method: string,
        ) {
          sent.push({ sessionId, method });
          return {
            frameTree: {
              frame: { id: "cdp-child" },
            },
          };
        },
      } as never,
      resolver: {
        async frameEpochForCdpFrame({
          cdpFrameId,
          cdpSessionId,
        }) {
          if (cdpFrameId === "cdp-main") {
            expect(cdpSessionId).toBeUndefined();
            return "epoch-main";
          }
          if (cdpFrameId === "cdp-child") {
            expect(cdpSessionId).toBe("session-child");
            return "epoch-child";
          }
          return undefined;
        },
      },
    });

    expect(sent).toEqual([{
      sessionId: "session-child",
      method: "Page.getFrameTree",
    }]);
    expect(correspondence.mappings).toContainEqual({
      webFrameId: "web:2",
      cdpFrameId: "cdp-child",
      cdpSessionId: "session-child",
      frameEpoch: "epoch-child",
      documentEpoch: "doc-child",
    });
  });

  it("相同 URL 等弱信号不会补偿缺失的 frameEpoch 对应关系", async () => {
    const correspondence = await mapDomFramesToCdp({
      tabId: 7,
      frames: [
        {
          frameId: "web:0",
          url: "https://same.test/",
          documentEpoch: "doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          url: "https://same.test/",
          documentEpoch: "doc-child",
          accessible: true,
        },
      ],
      dom: dom(),
      transport: rootTransport({
        frame: { id: "cdp-main" },
        childFrames: [
          { frame: { id: "cdp-child" } },
        ],
      }) as never,
      resolver: {
        async frameEpochForCdpFrame({ cdpFrameId }) {
          return cdpFrameId === "cdp-main"
            ? "epoch-main"
            : undefined;
        },
      },
    });

    expect(correspondence.mappings).toHaveLength(1);
    expect(correspondence.unmappedWebFrameIds).toEqual([
      "web:2",
    ]);
  });

  it("frameEpoch 跨 CDP session 冲突时 fail closed，不按 URL 或顺序消歧", async () => {
    const conflictedDom = dom();
    conflictedDom.frameEpochByFrame = {
      "web:0": "same-epoch",
      "web:2": "same-epoch",
    };

    const correspondence = await mapDomFramesToCdp({
      tabId: 7,
      frames: [
        {
          frameId: "web:0",
          url: "https://a.test/",
          documentEpoch: "doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          url: "https://b.test/",
          documentEpoch: "doc-child",
          accessible: true,
        },
      ],
      dom: conflictedDom,
      transport: rootTransport({
        frame: { id: "cdp-main" },
        childFrames: [
          { frame: { id: "cdp-child" } },
        ],
      }) as never,
      resolver: {
        async frameEpochForCdpFrame() {
          return "same-epoch";
        },
      },
    });

    expect(correspondence.mappings).toEqual([]);
    expect(correspondence.unmappedWebFrameIds.sort()).toEqual([
      "web:0",
      "web:2",
    ]);
    expect(
      correspondence.warnings.some((warning) =>
        warning.includes("非唯一"),
      ),
    ).toBe(true);
  });
});
