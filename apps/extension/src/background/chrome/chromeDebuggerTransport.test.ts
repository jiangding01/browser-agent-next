import { describe, expect, it, vi } from "vitest";
import { ChromeDebuggerReadTransport } from "./chromeDebuggerTransport.js";

describe("ChromeDebuggerReadTransport", () => {
  it("同一 tab 只 attach 一次，并记录 isolated-world execution context", async () => {
    const attach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    let eventListener:
      | ((
          source: { tabId?: number },
          method: string,
          params?: unknown,
        ) => void)
      | undefined;
    let detachListener:
      | ((source: { tabId?: number }, reason: string) => void)
      | undefined;

    const transport = new ChromeDebuggerReadTransport({
      attach,
      async detach() {},
      sendCommand,
      onEvent: {
        addListener(listener) {
          eventListener = listener;
        },
      },
      onDetach: {
        addListener(listener) {
          detachListener = listener;
        },
      },
    });

    await transport.send(7, "Page.getFrameTree");
    await transport.send(7, "Accessibility.getFullAXTree");

    expect(attach).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Runtime.enable",
      {},
    );

    eventListener?.(
      { tabId: 7 },
      "Runtime.executionContextCreated",
      {
        context: {
          id: 41,
          name: "",
          auxData: {
            frameId: "cdp-main",
            isDefault: false,
            type: "isolated",
          },
        },
      },
    );

    expect(transport.contextsForFrame(7, "cdp-main")).toHaveLength(1);

    detachListener?.({ tabId: 7 }, "target_closed");
    expect(transport.isAttached(7)).toBe(false);
    expect(transport.contextsForFrame(7, "cdp-main")).toEqual([]);
  });

  it("把 debugger 冲突转换为可诊断错误", async () => {
    const transport = new ChromeDebuggerReadTransport({
      async attach() {
        throw new Error("Another debugger is already attached");
      },
      async detach() {},
      async sendCommand() {
        return {};
      },
      onDetach: {
        addListener() {},
      },
    });

    await expect(
      transport.send(7, "Accessibility.getFullAXTree"),
    ).rejects.toThrow(/关闭目标 Tab 上的 DevTools/);
  });
});
