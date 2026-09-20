import { describe, expect, it, vi } from "vitest";
import { ChromeDebuggerReadTransport } from "./chromeDebuggerTransport.js";

describe("ChromeDebuggerReadTransport", () => {
  it("同一 tab 只 attach 一次，并记录 root isolated-world execution context", async () => {
    const attach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    let eventListener:
      | ((
          source: { tabId?: number; sessionId?: string },
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
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      },
    );
    expect(transport.flatAutoAttachEnabled(7)).toBe(true);

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
    expect(
      transport.contextBindingsForFrame(7, "cdp-main"),
    ).toEqual([
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
    ]);

    detachListener?.({ tabId: 7 }, "target_closed");
    expect(transport.isAttached(7)).toBe(false);
    expect(transport.contextsForFrame(7, "cdp-main")).toEqual([]);
    expect(transport.childSessions(7)).toEqual([]);
  });

  it("记录 OOPIF flat child session，并递归初始化 nested iframe auto-attach", async () => {
    const sendCommand = vi.fn(async () => ({}));
    let eventListener:
      | ((
          source: { tabId?: number; sessionId?: string },
          method: string,
          params?: unknown,
        ) => void)
      | undefined;

    const transport = new ChromeDebuggerReadTransport({
      async attach() {},
      async detach() {},
      sendCommand,
      onEvent: {
        addListener(listener) {
          eventListener = listener;
        },
      },
      onDetach: {
        addListener() {},
      },
    });

    await transport.attach(7);

    eventListener?.(
      { tabId: 7 },
      "Target.attachedToTarget",
      {
        sessionId: "session-child",
        targetInfo: {
          targetId: "target-child",
          type: "iframe",
        },
      },
    );

    await transport.waitForChildSessionInitialization(7);

    expect(transport.childSessions(7)).toEqual([
      {
        sessionId: "session-child",
        targetId: "target-child",
        targetType: "iframe",
      },
    ]);

    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: "session-child" },
      "Runtime.enable",
      {},
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: "session-child" },
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      },
    );

    eventListener?.(
      { tabId: 7, sessionId: "session-child" },
      "Runtime.executionContextCreated",
      {
        context: {
          id: 51,
          auxData: {
            frameId: "cdp-child",
            isDefault: false,
            type: "isolated",
          },
        },
      },
    );

    expect(transport.contextsForFrame(7, "cdp-child")).toEqual([]);
    expect(
      transport.contextBindingsForFrame(7, "cdp-child"),
    ).toEqual([
      {
        sessionId: "session-child",
        context: {
          id: 51,
          auxData: {
            frameId: "cdp-child",
            isDefault: false,
            type: "isolated",
          },
        },
      },
    ]);

    eventListener?.(
      { tabId: 7, sessionId: "session-child" },
      "Target.attachedToTarget",
      {
        sessionId: "session-nested",
        targetInfo: {
          targetId: "target-nested",
          type: "iframe",
        },
      },
    );

    await transport.waitForChildSessionInitialization(7);

    expect(transport.childSessions(7)).toContainEqual({
      sessionId: "session-nested",
      targetId: "target-nested",
      targetType: "iframe",
      parentSessionId: "session-child",
    });
  });

  it("非 iframe target 不进入 OOPIF session registry", async () => {
    let eventListener:
      | ((
          source: { tabId?: number; sessionId?: string },
          method: string,
          params?: unknown,
        ) => void)
      | undefined;

    const transport = new ChromeDebuggerReadTransport({
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: {
        addListener(listener) {
          eventListener = listener;
        },
      },
      onDetach: {
        addListener() {},
      },
    });

    await transport.attach(7);

    eventListener?.(
      { tabId: 7 },
      "Target.attachedToTarget",
      {
        sessionId: "worker-session",
        targetInfo: {
          targetId: "worker-target",
          type: "worker",
        },
      },
    );

    expect(transport.childSessions(7)).toEqual([]);
  });

  it("child target detach 会递归清理 session 与 execution contexts", async () => {
    let eventListener:
      | ((
          source: { tabId?: number; sessionId?: string },
          method: string,
          params?: unknown,
        ) => void)
      | undefined;

    const transport = new ChromeDebuggerReadTransport({
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: {
        addListener(listener) {
          eventListener = listener;
        },
      },
      onDetach: {
        addListener() {},
      },
    });

    await transport.attach(7);

    eventListener?.(
      { tabId: 7 },
      "Target.attachedToTarget",
      {
        sessionId: "parent",
        targetInfo: {
          targetId: "target-parent",
          type: "iframe",
        },
      },
    );
    eventListener?.(
      { tabId: 7, sessionId: "parent" },
      "Target.attachedToTarget",
      {
        sessionId: "child",
        targetInfo: {
          targetId: "target-child",
          type: "iframe",
        },
      },
    );
    eventListener?.(
      { tabId: 7, sessionId: "child" },
      "Runtime.executionContextCreated",
      {
        context: {
          id: 61,
          auxData: {
            frameId: "cdp-nested",
            isDefault: false,
          },
        },
      },
    );

    await transport.waitForChildSessionInitialization(7);

    eventListener?.(
      { tabId: 7 },
      "Target.detachedFromTarget",
      { sessionId: "parent" },
    );

    expect(transport.childSessions(7)).toEqual([]);
    expect(
      transport.contextBindingsForFrame(7, "cdp-nested"),
    ).toEqual([]);
  });

  it("flat auto-attach 不可用时保留 root 功能并让 OOPIF 能力 fail closed", async () => {
    const sendCommand = vi.fn(
      async (
        _target: unknown,
        method: string,
      ) => {
        if (method === "Target.setAutoAttach") {
          throw new Error("unsupported");
        }
        return {};
      },
    );

    const transport = new ChromeDebuggerReadTransport({
      async attach() {},
      async detach() {},
      sendCommand,
      onDetach: {
        addListener() {},
      },
    });

    await expect(
      transport.send(7, "Page.getFrameTree"),
    ).resolves.toEqual({});

    expect(transport.isAttached(7)).toBe(true);
    expect(transport.flatAutoAttachEnabled(7)).toBe(false);
    expect(transport.childSessions(7)).toEqual([]);
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
