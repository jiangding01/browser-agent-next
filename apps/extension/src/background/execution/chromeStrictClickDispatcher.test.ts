import { describe, expect, it, vi } from "vitest";
import { ChromeStrictClickDispatcher } from "./chromeStrictClickDispatcher.js";

describe("ChromeStrictClickDispatcher", () => {
  it("只负责对已经授权和 prepare 的点执行标准 left click 序列", async () => {
    const send = vi.fn(async () => undefined);
    const dispatcher = new ChromeStrictClickDispatcher({
      send,
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

    expect(send.mock.calls.map((call) => [
      call[1],
      (call[2] as { type: string }).type,
    ])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
  });
});
