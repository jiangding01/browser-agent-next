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
    coordinateSpace: "top-level-viewport" as const,
    point: { x: 20, y: 30 },
  };
}

describe("ChromeStrictClickDispatcher", () => {
  it("对已经授权和 prepare 的点只执行 press/release，不触发 hover", async () => {
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
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
  });

  it("非 top-level viewport 坐标在任何 Input dispatch 前拒绝", async () => {
    let sends = 0;
    const dispatcher = new ChromeStrictClickDispatcher({
      async send<T>(): Promise<T> {
        sends += 1;
        return undefined as T;
      },
    });

    await expect(
      dispatcher.dispatch({
        ...prepared(),
        coordinateSpace: "child-local" as never,
      }),
    ).rejects.toMatchObject({
      name: "StrictClickDispatchError",
      outcomeMayHaveChanged: false,
      phase: "before-input",
    } satisfies Partial<StrictClickDispatchError>);

    expect(sends).toBe(0);
  });

  it("mousePressed transport failure 后结果必须视为 unknown，且不发送 release", async () => {
    const calls: string[] = [];
    const dispatcher = new ChromeStrictClickDispatcher({
      async send<T>(
        _tabId: number,
        _method: string,
        params?: Record<string, unknown>,
      ): Promise<T> {
        calls.push(String(params?.type));
        if (params?.type === "mousePressed") {
          throw new Error("debugger response lost");
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

    expect(calls).toEqual(["mousePressed"]);
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
