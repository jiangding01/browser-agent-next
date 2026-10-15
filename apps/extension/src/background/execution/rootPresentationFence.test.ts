import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRESENTATION_FENCE_WORLD_NAME,
  createRootPresentationFence,
  presentationFenceExpression,
} from "./rootPresentationFence.js";
import type { StrictClickCdpTransport } from "./chromeStrictClickDispatcher.js";

interface RecordedCall {
  tabId: number;
  method: string;
  params?: Record<string, unknown>;
}

function preparedTarget(
  cdpSessionId?: string,
) {
  return {
    tabId: 7,
    ref: "@e_1",
    stableId: "s1",
    backendNodeId: 42,
    cdpFrameId: "cdp-frame",
    ...(cdpSessionId !== undefined
      ? { cdpSessionId }
      : {}),
    frameEpoch: "frame-a",
    coordinateSpace: "top-level-viewport" as const,
    point: { x: 10, y: 20 },
  };
}

function transport(options: {
  evaluate?: () => Promise<unknown>;
  calls?: RecordedCall[];
} = {}): StrictClickCdpTransport {
  return {
    async send<T>(
      tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      options.calls?.push({
        tabId,
        method,
        ...(params !== undefined ? { params } : {}),
      });

      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { id: "root-frame" } },
        } as T;
      }

      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 91 } as T;
      }

      if (method === "Runtime.evaluate") {
        return (await (
          options.evaluate ??
          (async () => ({
            result: {
              value: { presented: true, frames: 3 },
            },
          }))
        )()) as T;
      }

      throw new Error("unexpected method " + method);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRootPresentationFence.required", () => {
  it("OOPIF child session 内的目标总是需要 fence", () => {
    const fence = createRootPresentationFence(transport());

    expect(fence.required(preparedTarget("child-session")))
      .toBe(true);
  });

  it("main-frame / 同 process 目标由 root renderer 实时 hit-test，不需要 fence", () => {
    const fence = createRootPresentationFence(transport());

    expect(fence.required(preparedTarget())).toBe(false);
  });
});

describe("createRootPresentationFence.waitForPresentedFrames", () => {
  it("只在 root session 的独立 isolated world 中等待 animation frames", async () => {
    const calls: RecordedCall[] = [];
    const fence = createRootPresentationFence(
      transport({ calls }),
    );

    await expect(fence.waitForPresentedFrames(7))
      .resolves.toEqual({ ok: true, frames: 3 });

    expect(calls.map((call) => call.method)).toEqual([
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
    ]);
    expect(calls.every((call) => call.tabId === 7)).toBe(true);
    expect(calls[1]?.params).toEqual({
      frameId: "root-frame",
      worldName: PRESENTATION_FENCE_WORLD_NAME,
      grantUniveralAccess: false,
    });
    expect(calls[2]?.params).toMatchObject({
      contextId: 91,
      awaitPromise: true,
      returnByValue: true,
    });
  });

  it("页面内超时（没有足够 frame）时 fail closed", async () => {
    const fence = createRootPresentationFence(
      transport({
        evaluate: async () => ({
          result: {
            value: { presented: false, frames: 1 },
          },
        }),
      }),
    );

    await expect(fence.waitForPresentedFrames(7))
      .resolves.toMatchObject({ ok: false });
  });

  it("root 文档 hidden 时立即 fail closed 并给出准确原因", async () => {
    const fence = createRootPresentationFence(
      transport({
        evaluate: async () => ({
          result: {
            value: { presented: false, hidden: true, frames: 0 },
          },
        }),
      }),
    );

    await expect(fence.waitForPresentedFrames(7))
      .resolves.toEqual({
        ok: false,
        reason:
          "root document is hidden; the browser does not present frames for it",
      });
  });

  it("evaluate 抛出 exceptionDetails 时 fail closed", async () => {
    const fence = createRootPresentationFence(
      transport({
        evaluate: async () => ({
          result: {},
          exceptionDetails: { text: "boom" },
        }),
      }),
    );

    await expect(fence.waitForPresentedFrames(7))
      .resolves.toMatchObject({ ok: false });
  });

  it("transport 失败时返回 fail closed 结果而不是抛出", async () => {
    const fence = createRootPresentationFence(
      transport({
        evaluate: async () => {
          throw new Error("Cannot find context with specified id");
        },
      }),
    );

    await expect(fence.waitForPresentedFrames(7))
      .resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          "Cannot find context",
        ),
      });
  });

  it("renderer 冻结导致 evaluate 永不返回时由 host 侧超时 fail closed", async () => {
    vi.useFakeTimers();

    const fence = createRootPresentationFence(
      transport({
        evaluate: () => new Promise(() => undefined),
      }),
      { timeoutMs: 100 },
    );

    const pending = fence.waitForPresentedFrames(7);
    await vi.advanceTimersByTimeAsync(1_200);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "presentation fence timed out",
    });
  });
});

describe("presentationFenceExpression", () => {
  function runExpression(
    expression: string,
    requestAnimationFrame: (callback: () => void) => void,
    visibilityState = "visible",
  ): Promise<unknown> {
    const evaluate = new Function(
      "requestAnimationFrame",
      "setTimeout",
      "clearTimeout",
      "document",
      "return " + expression + ";",
    ) as (
      raf: typeof requestAnimationFrame,
      set: typeof setTimeout,
      clear: typeof clearTimeout,
      doc: { visibilityState: string },
    ) => Promise<unknown>;

    return evaluate(
      requestAnimationFrame,
      setTimeout,
      clearTimeout,
      { visibilityState },
    );
  }

  it("连续 present 指定数量的 frame 后 resolve", async () => {
    let frames = 0;

    await expect(
      runExpression(
        presentationFenceExpression(3, 1_000),
        (callback) => {
          frames += 1;
          setTimeout(callback, 0);
        },
      ),
    ).resolves.toEqual({ presented: true, frames: 3 });

    expect(frames).toBe(3);
  });

  it("hidden 文档不等待 rAF，立即报告 hidden", async () => {
    let frames = 0;

    await expect(
      runExpression(
        presentationFenceExpression(3, 1_000),
        () => {
          frames += 1;
        },
        "hidden",
      ),
    ).resolves.toEqual({
      presented: false,
      hidden: true,
      frames: 0,
    });

    expect(frames).toBe(0);
  });

  it("frame 不再推进时在页面内超时并报告未 present", async () => {
    await expect(
      runExpression(
        presentationFenceExpression(3, 20),
        () => undefined,
      ),
    ).resolves.toEqual({ presented: false, frames: 0 });
  });
});
