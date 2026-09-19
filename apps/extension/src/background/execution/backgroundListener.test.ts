import { describe, expect, it } from "vitest";
import { BrowserRuntimeError } from "@browser-agent-next/core";
import { registerStrictExecutionBackgroundListener } from "./backgroundListener.js";

describe("strict execution background listener", () => {
  it("只接受 extension 自己发出的 dry-run prepare 请求", async () => {
    let registered:
      | ((
          message: unknown,
          sender: { id?: string },
          sendResponse: (response: any) => void,
        ) => boolean | void)
      | undefined;

    const runtime = {
      id: "extension-id",
      onMessage: {
        addListener(listener: typeof registered) {
          registered = listener;
        },
        removeListener() {},
      },
    };

    registerStrictExecutionBackgroundListener(
      runtime as never,
      {
        async prepareClick() {
          return {
            tabId: 7,
            ref: "@e_1",
            stableId: "s1",
            backendNodeId: 42,
            cdpFrameId: "cdp-main",
            frameEpoch: "frame-a",
            point: { x: 10, y: 20 },
          };
        },
      } as never,
    );

    const externalResponses: unknown[] = [];
    const externalResult = registered?.(
      {
        type: "execution.prepare-strict-click",
        requestId: "r1",
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev",
        ref: "@e_1",
      },
      { id: "other-extension" },
      (response) => externalResponses.push(response),
    );

    expect(externalResult).toBeUndefined();
    expect(externalResponses).toEqual([]);

    const response = await new Promise<any>((resolve) => {
      registered?.(
        {
          type: "execution.prepare-strict-click",
          requestId: "r2",
          tabId: 7,
          actionId: "a2",
          observedRevision: "rev",
          ref: "@e_1",
        },
        { id: "extension-id" },
        resolve,
      );
    });

    expect(response).toMatchObject({
      ok: true,
      prepared: {
        ref: "@e_1",
        point: { x: 10, y: 20 },
      },
    });
  });

  it("保留 BrowserRuntimeError code 供上层做确定性路由", async () => {
    let registered: any;

    registerStrictExecutionBackgroundListener(
      {
        id: "extension-id",
        onMessage: {
          addListener(listener) {
            registered = listener;
          },
          removeListener() {},
        },
      },
      {
        async prepareClick() {
          throw new BrowserRuntimeError(
            "TARGET_IDENTITY_MISMATCH",
            "identity changed",
          );
        },
      } as never,
    );

    const response = await new Promise<any>((resolve) => {
      registered(
        {
          type: "execution.prepare-strict-click",
          requestId: "r3",
          tabId: 7,
          actionId: "a3",
          observedRevision: "rev",
          ref: "@e_1",
        },
        { id: "extension-id" },
        resolve,
      );
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "TARGET_IDENTITY_MISMATCH",
        message: "identity changed",
      },
    });
  });
});
