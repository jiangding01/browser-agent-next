import { describe, expect, it } from "vitest";
import { collectMainAxSource } from "./axSource.js";

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

  it("不会把 ignored、无 backend node 或非交互 AX node 暴露为 actionable", async () => {
    const result = await collectMainAxSource({
      tabId: 1,
      mainDocumentEpoch: "doc",
      transport: {
        async send(_tabId: number, method: string) {
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: { id: "main", url: "https://example.test/" },
              },
            };
          }

          return {
            nodes: [
              {
                nodeId: "ignored",
                ignored: true,
                role: { value: "button" },
                backendDOMNodeId: 1,
              },
              {
                nodeId: "no-backend",
                role: { value: "button" },
              },
              {
                nodeId: "heading",
                role: { value: "heading" },
                backendDOMNodeId: 2,
              },
              {
                nodeId: "field",
                role: { value: "textbox" },
                name: { value: "搜索" },
                backendDOMNodeId: 3,
              },
            ],
          };
        },
      } as never,
    });

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      kind: "field",
      semantic: { role: "textbox", name: "搜索" },
    });
  });

  it("达到 cap 时显式报告 truncated", async () => {
    const result = await collectMainAxSource({
      tabId: 1,
      mainDocumentEpoch: "doc",
      maxElements: 1,
      transport: {
        async send(_tabId: number, method: string) {
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: { id: "main", url: "https://example.test/" },
              },
            };
          }

          return {
            nodes: [
              {
                nodeId: "a",
                role: { value: "button" },
                backendDOMNodeId: 1,
              },
              {
                nodeId: "b",
                role: { value: "button" },
                backendDOMNodeId: 2,
              },
            ],
          };
        },
      } as never,
    });

    expect(result.coverage.actionable).toEqual({
      status: "truncated",
      returned: 1,
      totalKnown: 2,
      reason: "ax-output-cap",
    });
  });
});
