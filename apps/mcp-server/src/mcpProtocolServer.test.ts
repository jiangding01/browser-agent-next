import { describe, expect, it, vi } from "vitest";
import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import type {
  ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
  ModelFacingMcpBridge,
  type ModelFacingToolInvoker,
} from "./mcpProtocolServer.js";

function textOf(
  result: Awaited<ReturnType<ModelFacingMcpBridge["callTool"]>>,
): string {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text tool result");
  }
  return first.text;
}

function invoker(
  tools: ModelFacingToolName[] = [
    "browser.observe",
    "browser.verify",
  ],
): ModelFacingToolInvoker & {
  invoke: ReturnType<typeof vi.fn>;
} {
  return {
    exposedTools: () => tools,
    invoke: vi.fn(async (name: string) => ({
      ok: true,
      name,
    })),
  };
}

describe("ModelFacingMcpBridge", () => {
  it("tools/list 只返回 invoker 显式暴露的 catalog 子集", () => {
    const bridge = new ModelFacingMcpBridge(
      invoker(["browser.observe"]),
    );

    expect(bridge.listTools().map((tool) => tool.name))
      .toEqual(["browser.observe"]);
  });

  it("未暴露工具在 dispatch 前 fail closed", async () => {
    const target = invoker(["browser.observe"]);
    const bridge = new ModelFacingMcpBridge(target);

    const result = await bridge.callTool(
      "authorization.issue-strict-click",
      {},
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("POLICY_BLOCKED");
    expect(target.invoke).not.toHaveBeenCalled();
  });

  it("成功结果只作为 JSON text content 返回", async () => {
    const target = invoker(["browser.observe"]);
    const bridge = new ModelFacingMcpBridge(target);

    const result = await bridge.callTool(
      "browser.observe",
      { tabId: 7 },
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({
      ok: true,
      name: "browser.observe",
    });
    expect(target.invoke).toHaveBeenCalledWith(
      "browser.observe",
      { tabId: 7 },
    );
  });

  it("BrowserRuntimeError 只暴露 bounded code/message，不暴露 details", async () => {
    const target = invoker(["browser.verify"]);
    target.invoke.mockRejectedValueOnce(
      new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "blocked",
        { secret: "do-not-leak" },
      ),
    );
    const bridge = new ModelFacingMcpBridge(target);

    const result = await bridge.callTool(
      "browser.verify",
      {},
    );
    const body = textOf(result);

    expect(result.isError).toBe(true);
    expect(body).toContain("MODEL_EGRESS_BLOCKED");
    expect(body).toContain("blocked");
    expect(body).not.toContain("do-not-leak");
  });

  it("未知异常返回稳定 INTERNAL_ERROR，不泄露原始错误", async () => {
    const target = invoker(["browser.observe"]);
    target.invoke.mockRejectedValueOnce(
      new Error("filesystem secret /tmp/private"),
    );
    const bridge = new ModelFacingMcpBridge(target);

    const result = await bridge.callTool(
      "browser.observe",
      {},
    );
    const body = textOf(result);

    expect(result.isError).toBe(true);
    expect(body).toContain("INTERNAL_ERROR");
    expect(body).not.toContain("filesystem secret");
  });

  it("超出结果预算时 fail closed", async () => {
    const target = invoker(["browser.observe"]);
    target.invoke.mockResolvedValueOnce({
      text: "x".repeat(512),
    });
    const bridge = new ModelFacingMcpBridge(
      target,
      { maxResultBytes: 128 },
    );

    const result = await bridge.callTool(
      "browser.observe",
      {},
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "MODEL_EGRESS_BLOCKED",
    );
  });

  it("默认结果预算保持有界", () => {
    expect(DEFAULT_MCP_RESULT_MAX_BYTES).toBe(256 * 1024);
  });
});
