import { describe, expect, it } from "vitest";
import {
  collectMainAxSource,
  collectMappedAxSource,
} from "./axSource.js";

describe("collectMainAxSource", () => {
  it("把 backendDOMNodeId 作为 document-scoped AX strong identity", async () => {
    const sent: string[] = [];

    const result = await collectMainAxSource({
      tabId: 9,
      mainDocumentEpoch: "chrome-document:doc-main",
      transport: {
        async send(_tabId: number, method: string) {
          sent.push(method);

          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: {
                  id: "cdp-main",
                  url: "https://example.test/",
                },
              },
            };
          }

          return {
            nodes: [
              {
                nodeId: "ax-1",
                role: { value: "button" },
                name: { value: "保存" },
                backendDOMNodeId: 42,
                properties: [
                  { name: "disabled", value: { value: false } },
                ],
              },
            ],
          };
        },
      } as never,
    });

    expect(sent).toEqual([
      "Page.getFrameTree",
      "Accessibility.getFullAXTree",
    ]);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      source: "ax",
      identity: {
        source: "ax",
        tabId: 9,
        cdpFrameId: "cdp-main",
        documentEpoch: "chrome-document:doc-main",
        backendNodeId: 42,
      },
      semantic: {
        role: "button",
        name: "保存",
      },
    });
  });
});

describe("collectMappedAxSource", () => {
  it("按 exact frame mapping 采集 main + child AX，并保留 web frame identity", async () => {
    const result = await collectMappedAxSource({
      tabId: 7,
      mappings: [
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
      ],
      expectedFrameIds: ["web:0", "web:2"],
      transport: {
        async send(_tabId: number, _method: string, params: { frameId?: string }) {
          return {
            nodes: [
              {
                nodeId: "ax-" + params.frameId,
                role: { value: "button" },
                name: {
                  value: params.frameId === "cdp-main"
                    ? "Save"
                    : "Child Action",
                },
                backendDOMNodeId:
                  params.frameId === "cdp-main" ? 42 : 84,
              },
            ],
          };
        },
      } as never,
    });

    expect(result.coverage.actionable.status).toBe("complete");
    expect(result.elements).toEqual([
      expect.objectContaining({
        frameId: "web:0",
        identity: expect.objectContaining({
          cdpFrameId: "cdp-main",
          documentEpoch: "doc-main",
        }),
      }),
      expect.objectContaining({
        frameId: "web:2",
        identity: expect.objectContaining({
          cdpFrameId: "cdp-child",
          documentEpoch: "doc-child",
        }),
      }),
    ]);
  });

  it("任一 accessible frame 未建立 exact mapping 时 coverage=partial", async () => {
    const result = await collectMappedAxSource({
      tabId: 7,
      mappings: [
        {
          webFrameId: "web:0",
          cdpFrameId: "cdp-main",
          frameEpoch: "epoch-main",
          documentEpoch: "doc-main",
        },
      ],
      expectedFrameIds: ["web:0", "web:2"],
      transport: {
        async send() {
          return { nodes: [] };
        },
      } as never,
    });

    expect(result.coverage.actionable).toMatchObject({
      status: "partial",
      reason: "one-or-more-frames-unmapped",
    });
    expect(result.degradedFrames).toEqual(["web:2"]);
  });
});
