import { describe, expect, it, vi } from "vitest";
import {
  BrowserChangeSignalHub,
  registerBrowserChangeSignals,
} from "./browserChangeSignalHub.js";

describe("BrowserChangeSignalHub", () => {
  it("signal 在 waiter 注册前发生也不会丢失", async () => {
    const hub = new BrowserChangeSignalHub();
    const cursor = hub.version(7);

    hub.notify(7);

    await expect(
      hub.waitForChange(7, cursor, 1_000),
    ).resolves.toBe(true);
  });

  it("没有 signal 时按 timeout 返回 false", async () => {
    vi.useFakeTimers();
    try {
      const hub = new BrowserChangeSignalHub();
      const pending = hub.waitForChange(
        7,
        hub.version(7),
        100,
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DOM signal 与 navigation 都可以唤醒，非法 sender 不生效", () => {
    let runtimeListener:
      | ((message: unknown, sender: any) => void)
      | undefined;
    let committedListener:
      | ((details: any) => void)
      | undefined;

    const hub = new BrowserChangeSignalHub();
    registerBrowserChangeSignals(
      {
        id: "extension-id",
        onMessage: {
          addListener(listener) {
            runtimeListener = listener as never;
          },
          removeListener() {},
        },
      },
      {
        tabs: {
          onRemoved: {
            addListener() {},
            removeListener() {},
          },
        },
        webNavigation: {
          onCommitted: {
            addListener(listener) {
              committedListener = listener as never;
            },
            removeListener() {},
          },
        },
      },
      hub,
    );

    runtimeListener?.(
      {
        type: "perception.dom-changed",
        frameEpoch: "epoch",
        sequence: 1,
      },
      {
        id: "wrong-extension",
        tab: { id: 7 },
      },
    );
    expect(hub.version(7)).toBe(0);

    runtimeListener?.(
      {
        type: "perception.dom-changed",
        frameEpoch: "epoch",
        sequence: 1,
      },
      {
        id: "extension-id",
        tab: { id: 7 },
      },
    );
    expect(hub.version(7)).toBe(1);

    committedListener?.({
      tabId: 7,
      frameId: 0,
      documentId: "doc",
    });
    expect(hub.version(7)).toBe(2);
  });
});
