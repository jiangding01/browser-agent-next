import { describe, expect, it, vi } from "vitest";
import { ChromeStrictClickDispatcher } from "./chromeStrictClickDispatcher.js";

describe("ChromeStrictClickDispatcher", () => {
  it("只负责对已经授权和 prepare 的点执行标准 left click 序列", async () => {
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
        calls.push({ tabId, method, params });
        return undefined as T;
      },
    });

    await dispatcher.dispatch({
      tabId: 7,
      ref: "@e_1",
      stableId: "s1",
      backendNodeId: 42,
      cdpFrameId: "cdp-main",
      frameEpoch: "frame-a",
      point: { x: 20, y: 30 },
    });

    expect(calls.map((call) => [
      call.method,
      call.params?.type,
    ])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
  });
});
