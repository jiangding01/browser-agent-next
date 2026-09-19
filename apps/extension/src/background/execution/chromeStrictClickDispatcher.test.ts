import { describe, expect, it } from "vitest";
import {
  ChromeStrictClickDispatcher,
  StrictClickDispatchError,
} from "./chromeStrictClickDispatcher.js";

function prepared() {
  return {
    tabId: 7,
    ref: "@e_1",
    stableId: "s1",
    backendNodeId: 42,
    cdpFrameId: "cdp-main",
    frameEpoch: "frame-a",
    point: { x: 20, y: 30 },
  };
}

describe("ChromeStrictClickDispatcher", () => {
  it("对已经授权和 prepare 的点执行标准 left click 序列", async () => {
    const calls: Array<{
      tabId: number;
      method: string;
      params?: Record<string, unknown>;
    }> = [];

    const dispatcher = new ChromeStrictClickDispatcher({
      async send<T>(
        tabId: number,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T> {
        calls.push({
          tabId,
          method,
          ...(params !== undefined ? { params } : {}),
        });
        return undefined as T;
      },
    });

    await dispatcher.dispatch(prepared());

    expect(calls.map((call) => [
      call.method,
      call.params?.type,
    ])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
  });

  it("mousePressed 之前失败可以确认没有 click outcome", async () => {
    const dispatcher = new ChromeStrictClickDispatcher({
      async send<T>(
        _tabId: number,
        _method: string,
        params?: Record<string, unknown>,
      ): Promise<T> {
        if (params?.type === "mousePressed") {
          throw new Error("press failed");
        }
        return undefined as T;
      },
    });

    await expect(
      dispatcher.dispatch(prepared()),
    ).rejects.toMatchObject({
      name: "StrictClickDispatchError",
      outcomeMayHaveChanged: false,
      phase: "mouse-moved",
    } satisfies Partial<StrictClickDispatchError>);
  });

  it("mousePressed 已成功但 release 失败时标记为 outcome unknown", async () => {
    const dispatcher = new ChromeStrictClickDispatcher({
      async send<T>(
        _tabId: number,
        _method: string,
        params?: Record<string, unknown>,
      ): Promise<T> {
        if (params?.type === "mouseReleased") {
          throw new Error("target closed");
        }
        return undefined as T;
      },
    });

    await expect(
      dispatcher.dispatch(prepared()),
    ).rejects.toMatchObject({
      name: "StrictClickDispatchError",
      outcomeMayHaveChanged: true,
      phase: "mouse-pressed",
    } satisfies Partial<StrictClickDispatchError>);
  });
});
