import { describe, expect, it } from "vitest";
import { IsolatedWorldDomStableIdInspector } from "./domStableIdInspector.js";

describe("IsolatedWorldDomStableIdInspector", () => {
  it("只接受 frameEpoch 匹配的 isolated-world bridge", async () => {
    const calls: string[] = [];

    const inspector = new IsolatedWorldDomStableIdInspector({
      async attach() {},
      contextsForFrame() {
        return [
          {
            id: 11,
            auxData: {
              frameId: "cdp-main",
              isDefault: false,
              type: "isolated",
            },
          },
        ];
      },
      async send(_tabId: number, method: string) {
        calls.push(method);

        if (method === "Runtime.evaluate") {
          return { result: { objectId: "bridge-1" } };
        }

        if (method === "Runtime.callFunctionOn" && calls.filter((entry) => entry === method).length === 1) {
          return {
            result: {
              value: {
                version: 1,
                frameEpoch: "frame-a",
              },
            },
          };
        }

        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: {
                visible: true,
                enabled: true,
                inViewport: true,
                hitTestable: true,
                rect: { x: 10, y: 20, width: 100, height: 30 },
                point: { x: 60, y: 35 },
              },
            },
          };
        }

        return { result: {} };
      },
    } as never);

    const result = await inspector.inspect({
      tabId: 7,
      cdpFrameId: "cdp-main",
      frameEpoch: "frame-a",
      stableId: "s1",
    });

    expect(result).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      hitTestable: true,
      point: { x: 60, y: 35 },
    });
  });
});
