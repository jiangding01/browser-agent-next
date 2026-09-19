import { describe, expect, it, vi } from "vitest";
import { ChromeDomObservationService } from "./chromeObservationService.js";

function frameCatalog() {
  return [
    {
      frameId: 0,
      parentFrameId: -1,
      url: "https://fixture.test/",
      documentId: "doc-main",
    },
  ];
}

describe("ChromeDomObservationService", () => {
  it("默认保持 DOM-only，不会静默启用 AX 导致重复 ref", async () => {
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
        extraSources: expect.anything(),
      }),
    );
  });

  it("显式 includeAx 时把 AX source 接入 canonical coordinator", async () => {
    const observe = vi.fn(async (input: unknown) => input);

    const debuggerTransport = {
      async send(_tabId: number, method: string) {
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "cdp-main",
                url: "https://fixture.test/",
              },
            },
          };
        }

        return {
          nodes: [
            {
              nodeId: "ax-1",
              role: { value: "button" },
              name: { value: "Save" },
              backendDOMNodeId: 42,
            },
          ],
        };
      },
    };

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
      debuggerTransport as never,
    );

    await service.observe({
      tabId: 1,
      ownedBySession: true,
      options: { includeAx: true },
    });

    const input = observe.mock.calls[0]?.[0] as {
      extraSources?: Array<{ source: string; elements: unknown[] }>;
    };

    expect(input.extraSources).toHaveLength(1);
    expect(
      (observe.mock.calls[0]?.[0] as { refineSources?: unknown }).refineSources,
    ).toEqual(expect.any(Function));
    expect(input.extraSources?.[0]).toMatchObject({
      source: "ax",
      elements: [
        expect.objectContaining({
          identity: expect.objectContaining({
            backendNodeId: 42,
          }),
        }),
      ],
    });
  });

  it("存在 child frame 时 AX coverage 不会错误报告 complete", async () => {
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
          return [
            ...frameCatalog(),
            {
              frameId: 2,
              parentFrameId: 0,
              url: "https://fixture.test/child",
              documentId: "doc-child",
            },
          ];
        },
      },
      { observe } as never,
      {
        async send(_tabId: number, method: string) {
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: {
                  id: "cdp-main",
                  url: "https://fixture.test/",
                },
              },
            };
          }
          return { nodes: [] };
        },
      } as never,
    );

    await service.observe({
      tabId: 1,
      ownedBySession: true,
      options: { includeAx: true },
    });

    const input = observe.mock.calls[0]?.[0] as {
      extraSources?: Array<{
        coverage: { actionable: { status: string } };
      }>;
    };

    expect(input.extraSources?.[0]?.coverage.actionable.status).toBe("partial");
  });
});
