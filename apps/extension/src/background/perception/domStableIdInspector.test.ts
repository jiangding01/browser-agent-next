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

  it("指定 cdpSessionId 时只使用对应 child session context 与 command", async () => {
    const calls: string[] = [];
    const inspector = new IsolatedWorldDomStableIdInspector({
      async attach() {},
      contextsForFrame() {
        return [];
      },
      contextBindingsForFrame() {
        return [
          {
            sessionId: "session-child",
            context: {
              id: 22,
              auxData: {
                frameId: "cdp-child",
                isDefault: false,
              },
            },
          },
          {
            sessionId: "other-session",
            context: {
              id: 33,
              auxData: {
                frameId: "cdp-child",
                isDefault: false,
              },
            },
          },
        ];
      },
      async send() {
        throw new Error("child inspection 不应发送 root command");
      },
      async sendInSession(_tabId: number, sessionId: string, method: string) {
        calls.push(sessionId + ":" + method);
        if (method === "Runtime.evaluate") {
          return { result: { objectId: "bridge-child" } };
        }
        const sameMethodCount =
          calls.filter((entry) => entry.endsWith(":" + method)).length;
        if (method === "Runtime.callFunctionOn" && sameMethodCount === 1) {
          return {
            result: {
              value: {
                version: 1,
                frameEpoch: "frame-child",
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
                rect: { x: 1, y: 2, width: 30, height: 20 },
                point: { x: 16, y: 12 },
              },
            },
          };
        }
        return { result: {} };
      },
    } as never);

    const result = await inspector.inspect({
      tabId: 7,
      cdpFrameId: "cdp-child",
      cdpSessionId: "session-child",
      frameEpoch: "frame-child",
      stableId: "child-stable",
    });

    expect(result?.point).toEqual({ x: 16, y: 12 });
    expect(calls.every((call) => call.startsWith("session-child:")))
      .toBe(true);
    expect(calls.at(-1)).toBe(
      "session-child:Runtime.releaseObjectGroup",
    );
  });
});
