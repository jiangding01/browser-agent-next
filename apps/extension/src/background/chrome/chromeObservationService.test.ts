import { describe, expect, it, vi } from "vitest";
import { ChromeDomObservationService } from "./chromeObservationService.js";
import type { CollectedDomSource } from "../perception/domCollector.js";

function frameCatalog() {
  return [
    {
      frameId: 0,
      parentFrameId: -1,
      url: "https://fixture.test/",
      documentId: "doc-main",
    },
    {
      frameId: 2,
      parentFrameId: 0,
      url: "https://fixture.test/child",
      documentId: "doc-child",
    },
  ];
}

function collectedDom(): CollectedDomSource {
  return {
    source: "dom",
    coverage: {
      actionable: { status: "complete", returned: 2, totalKnown: 2 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
    },
    frameEpochByFrame: {
      "web:0": "epoch-main",
      "web:2": "epoch-child",
    },
    viewportByFrame: {},
    elements: [
      {
        source: "dom",
        identity: {
          source: "dom",
          tabId: 1,
          frameEpoch: "epoch-main",
          stableId: "s-main",
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
          tabId: 1,
          frameEpoch: "epoch-child",
          stableId: "s-child",
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

function debuggerTransport() {
  const contextByFrame: Record<string, number> = {
    "cdp-main": 11,
    "cdp-child": 22,
  };

  return {
    async attach() {},
    async waitForChildSessionInitialization() {},
    childSessions() {
      return [];
    },
    contextsForFrame(_tabId: number, frameId: string) {
      const id = contextByFrame[frameId];
      return id === undefined
        ? []
        : [{
            id,
            auxData: {
              frameId,
              isDefault: false,
            },
          }];
    },
    async send(_tabId: number, method: string, params: Record<string, any> = {}) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "cdp-main" },
            childFrames: [
              { frame: { id: "cdp-child" } },
            ],
          },
        };
      }

      if (
        method === "Runtime.evaluate" &&
        params.returnByValue === true
      ) {
        return {
          result: {
            value:
              params.contextId === 11
                ? "epoch-main"
                : "epoch-child",
          },
        };
      }

      if (method === "Accessibility.getFullAXTree") {
        const child = params.frameId === "cdp-child";
        return {
          nodes: [{
            nodeId: child ? "ax-child" : "ax-main",
            role: { value: "button" },
            name: {
              value: child ? "Child Action" : "Save",
            },
            backendDOMNodeId: child ? 84 : 42,
          }],
        };
      }

      if (
        method === "Runtime.evaluate" &&
        params.returnByValue === false
      ) {
        return {
          result: {
            objectId:
              params.contextId === 11
                ? "bridge-main"
                : "bridge-child",
          },
        };
      }

      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes(
          "return {version:this.version",
        )
      ) {
        return {
          result: {
            value: {
              version: 1,
              frameEpoch:
                params.objectId === "bridge-main"
                  ? "epoch-main"
                  : "epoch-child",
            },
          },
        };
      }

      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params.backendNodeId === 42
                ? "node-main"
                : "node-child",
          },
        };
      }

      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes(
          "stableIdOf",
        )
      ) {
        return {
          result: {
            value:
              params.arguments?.[0]?.objectId === "node-main"
                ? "s-main"
                : "s-child",
          },
        };
      }

      if (method === "Runtime.releaseObjectGroup") {
        return {};
      }

      throw new Error("unexpected method: " + method);
    },
  };
}

describe("ChromeDomObservationService", () => {
  it("默认保持 DOM-only，不会静默启用 AX", async () => {
    const observe = vi.fn(async (input: unknown) => input);

    const service = new ChromeDomObservationService(
      {
        async get() {
          return { id: 1, title: "Fixture" };
        },
        async sendMessage() {
          throw new Error("not used");
        },
      },
      {
        async getAllFrames() {
          return frameCatalog();
        },
      },
      { observe } as never,
    );

    await service.observe({
      tabId: 1,
      ownedBySession: true,
    });

    expect(observe).toHaveBeenCalledWith(
      expect.not.objectContaining({
        refineSources: expect.anything(),
      }),
    );
  });

  it("includeAx 时在 DOM 收集后建立 main + child exact mapping", async () => {
    const observe = vi.fn(async (input: any) => {
      const refined = await input.refineSources({
        dom: collectedDom(),
        extraSources: [],
      });
      return refined;
    });

    const service = new ChromeDomObservationService(
      {
        async get() {
          return { id: 1, title: "Fixture" };
        },
        async sendMessage() {
          throw new Error("not used");
        },
      },
      {
        async getAllFrames() {
          return frameCatalog();
        },
      },
      { observe } as never,
      debuggerTransport() as never,
    );

    const result = await service.observe({
      tabId: 1,
      ownedBySession: true,
      options: { includeAx: true },
    }) as any;

    expect(result.extraSources).toHaveLength(1);
    expect(result.extraSources[0].coverage.actionable.status).toBe("complete");
    expect(result.frameBindingsByFrame).toEqual({
      "web:0": {
        frameEpoch: "epoch-main",
        cdpFrameId: "cdp-main",
        documentEpoch: "chrome-document:doc-main",
      },
      "web:2": {
        frameEpoch: "epoch-child",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:doc-child",
      },
    });

    const axElements = result.extraSources[0].elements;
    expect(axElements).toEqual([
      expect.objectContaining({
        frameId: "web:0",
        mergeKey:
          "backend:cdp-main:chrome-document:doc-main:42",
      }),
      expect.objectContaining({
        frameId: "web:2",
        mergeKey:
          "backend:cdp-child:chrome-document:doc-child:84",
      }),
    ]);

    expect(result.dom.elements).toEqual([
      expect.objectContaining({
        frameId: "web:0",
        mergeKey:
          "backend:cdp-main:chrome-document:doc-main:42",
      }),
      expect.objectContaining({
        frameId: "web:2",
        mergeKey:
          "backend:cdp-child:chrome-document:doc-child:84",
      }),
    ]);
  });
});
