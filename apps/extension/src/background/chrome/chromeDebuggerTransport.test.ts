import { describe, expect, it, vi } from "vitest";
import { ChromeDebuggerReadTransport } from "./chromeDebuggerTransport.js";

describe("ChromeDebuggerReadTransport", () => {
  it("同一 tab 只 attach 一次，并启用只读感知所需 domain", async () => {
    const attach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    let detachListener: ((source: { tabId?: number }, reason: string) => void) | undefined;

    const transport = new ChromeDebuggerReadTransport({
      attach,
      async detach() {},
      sendCommand,
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
      "DOM.enable",
      {},
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Accessibility.enable",
      {},
    );

    detachListener?.({ tabId: 7 }, "target_closed");
    expect(transport.isAttached(7)).toBe(false);
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
