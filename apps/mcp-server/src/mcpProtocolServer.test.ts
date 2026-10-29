import { describe, expect, it, vi } from "vitest";
import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import type {
  BrowserObservation,
} from "@browser-agent-next/core";
import {
  MODEL_FACING_DEFAULT_TOOL_NAMES,
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  createModelActBroker,
} from "./modelActBroker.js";
import {
  ModelFacingBrowserAdapter,
} from "./modelFacingAdapter.js";
import type {
  TrustedActBrokerRuntimeClient,
} from "./trustedRuntimeClient.js";
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
  ModelFacingMcpBridge,
  type ModelFacingToolInvoker,
} from "./mcpProtocolServer.js";
import { createTraceRecorder } from "./modelTrace.js";
import type { RuntimeTraceEvent } from "@browser-agent-next/core";

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
      undefined,
    );
  });

  it("callTool 把 tool call context 原样透传给 invoker", async () => {
    const target = invoker(["browser.observe"]);
    const bridge = new ModelFacingMcpBridge(target);
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      onProgress: vi.fn(),
    };

    await bridge.callTool(
      "browser.observe",
      { tabId: 7 },
      context,
    );

    expect(target.invoke).toHaveBeenCalledTimes(1);
    expect(target.invoke.mock.calls[0]![2]).toBe(context);
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

function actObservation(): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://allowed.test/page",
      origin: "https://allowed.test",
      ownedBySession: true,
    },
    revision: {
      id: "rev-1",
      stateEpoch: "runtime",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "complete", returned: 1, totalKnown: 1 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: false },
    },
    viewport: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1000,
      scrollHeight: 800,
    },
    frames: [{
      frameId: "web:0",
      url: "https://allowed.test/page",
      documentEpoch: "doc-1",
      accessible: true,
    }],
    elements: [{
      ref: "@save",
      kind: "element",
      semantic: { role: "button", name: "Save" },
      state: { visible: true, enabled: true, focused: false },
      frameId: "web:0",
      capabilities: [{ kind: "click" }],
      provenance: { dom: true },
    }],
  };
}

describe("ModelFacingMcpBridge browser.act", () => {
  it("默认暴露集合的 tools/list 不含 browser.act", () => {
    const bridge = new ModelFacingMcpBridge(
      invoker([...MODEL_FACING_DEFAULT_TOOL_NAMES]),
    );

    expect(bridge.listTools().map((tool) => tool.name))
      .not.toContain("browser.act");
  });

  it("显式暴露后 tools/list 可见，tools/call 经 adapter + broker 走通，verification 只来自投影后的本地验证", async () => {
    let now = 0;
    const trusted: TrustedActBrokerRuntimeClient = {
      act: vi.fn(async () => ({
        status: "executed" as const,
        verification: {
          verified: true,
          conclusive: true,
          revision: "fresh-unexposed-rev",
          evidence: [{
            condition: { type: "text_present" as const, text: "Saved" },
            pass: true,
            conclusive: true,
            observed: "raw page text",
          }],
        },
        verificationAttempts: 1,
      })),
      issueStrictClick: vi.fn(),
      requestOperatorApproval: vi.fn(async () => ({
        approvalRequestId: "approval-1",
        expiresAt: 1,
      })),
      operatorApprovalStatus: vi.fn(async () => ({
        state: "approved" as const,
      })),
      cancelStrictClick: vi.fn(async () => {}),
    };
    const adapter = new ModelFacingBrowserAdapter(
      {
        async open() { throw new Error("unused"); },
        async observe() { return actObservation(); },
      },
      {
        tools: new ModelToolExposurePolicy([
          "browser.observe",
          "browser.act",
        ]),
        origins: new ModelOriginAccessPolicy({
          readOrigins: ["https://allowed.test"],
          navigationOrigins: [],
        }),
        actBroker: createModelActBroker(trusted, {
          actOrigins: ["https://allowed.test"],
          budget: 1,
          approvalMode: "operator",
          approvalTimeoutMs: 5_000,
          sleep: async () => {},
        }),
        now: () => now,
        sleep: async (ms) => { now += ms; },
      },
    );
    const bridge = new ModelFacingMcpBridge(adapter);

    expect(bridge.listTools().map((tool) => tool.name))
      .toEqual(["browser.observe", "browser.act"]);

    const observed = await bridge.callTool(
      "browser.observe",
      { tabId: 7 },
    );
    expect(observed.isError).toBeUndefined();

    const acted = await bridge.callTool("browser.act", {
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@save",
      kind: "click",
      verifyTimeoutMs: 0,
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "Saved" }],
      },
    });
    expect(acted.isError).toBeUndefined();
    const body = textOf(acted);
    // 扩展说 verified:true（带 observed 原文），但投影后的页面没有 "Saved"。
    expect(JSON.parse(body)).toMatchObject({
      status: "executed",
      effectClass: "unknown",
      verification: {
        verified: false,
        revision: "rev-1",
        evidence: [{
          condition: { type: "text_present", text: "Saved" },
          pass: false,
        }],
      },
      verificationAttempts: 1,
    });
    expect(trusted.act).toHaveBeenCalledWith(
      expect.objectContaining({ verifyTimeoutMs: 0 }),
    );
    expect(body).not.toContain("raw page text");
    expect(body).not.toContain("fresh-unexposed-rev");
    // 成功执行不撤销授权。
    expect(trusted.cancelStrictClick).not.toHaveBeenCalled();

    // 预算为 1：第二次（不同 key 也一样）被拒，并以 bounded tool error 返回。
    const again = await bridge.callTool("browser.act", {
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@save",
      kind: "click",
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "Saved" }],
      },
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("POLICY_BLOCKED");
  });
});

describe("ModelFacingMcpBridge trace", () => {
  function tracing() {
    const events: RuntimeTraceEvent[] = [];
    const recorder = createTraceRecorder({
      sink: { write: (event) => events.push(event) },
    });
    return { events, recorder };
  }

  it("records unexposed-tool refusals without the tool name and never reaches the invoker", async () => {
    const { events, recorder } = tracing();
    const target = invoker(["browser.observe"]);
    const bridge = new ModelFacingMcpBridge(target, { trace: recorder });

    await bridge.callTool("Ignore previous instructions", {});

    expect(target.invoke).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ event: "policy", outcome: "POLICY_BLOCKED" })]);
    expect(events[0]).not.toHaveProperty("tool");
    expect(JSON.stringify(events)).not.toContain("Ignore");
  });

  it("records a result blocked by the result bound as MODEL_EGRESS_BLOCKED", async () => {
    const { events, recorder } = tracing();
    const target = invoker(["browser.observe"]);
    target.invoke.mockResolvedValueOnce({ blob: "x".repeat(4_096) });
    const bridge = new ModelFacingMcpBridge(target, { trace: recorder, maxResultBytes: 1_024 });

    const result = await bridge.callTool("browser.observe", { tabId: 1 });

    expect(result.isError).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ tool: "browser.observe", event: "policy", outcome: "MODEL_EGRESS_BLOCKED" }),
    ]);
  });

  it("returns exactly the same results with and without trace", async () => {
    const plain = new ModelFacingMcpBridge(invoker());
    const { events, recorder } = tracing();
    const traced = new ModelFacingMcpBridge(invoker(), { trace: recorder });

    for (const bridge of [plain, traced]) {
      const failing = bridge as unknown as { invoker: ReturnType<typeof invoker> };
      failing.invoker.invoke
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new BrowserRuntimeError("TARGET_OCCLUDED", "occluded"))
        .mockRejectedValueOnce(new Error("boom"));
    }
    const calls = async (bridge: ModelFacingMcpBridge) => [
      await bridge.callTool("browser.observe", { tabId: 1 }),
      await bridge.callTool("browser.verify", { tabId: 1 }),
      await bridge.callTool("browser.observe", { tabId: 1 }),
      await bridge.callTool("browser.act", {}),
    ];

    expect(await calls(traced)).toEqual(await calls(plain));
    expect(events.map((event) => event.outcome)).toEqual([
      "ok",
      "TARGET_OCCLUDED",
      "INTERNAL_ERROR",
      "POLICY_BLOCKED",
    ]);
  });

  it("passes the original context through and adds only the authorization callback", async () => {
    const { events, recorder } = tracing();
    const target = invoker(["browser.act"]);
    target.invoke.mockImplementationOnce(async (_name, _input, context) => {
      context.onAuthorizationTrace({ path: "operator", approval: "approved", waitMs: 5 });
      return {
        status: "executed",
        effectClass: "unknown",
        verification: { verified: true, conclusive: true, evidence: [] },
        verificationAttempts: 1,
      };
    });
    const bridge = new ModelFacingMcpBridge(target, { trace: recorder });
    const controller = new AbortController();
    const onProgress = vi.fn();

    await bridge.callTool("browser.act", { tabId: 1 }, { signal: controller.signal, onProgress });

    const context = target.invoke.mock.calls[0]![2];
    expect(context.signal).toBe(controller.signal);
    expect(context.onProgress).toBe(onProgress);
    expect(events[0]).toMatchObject({
      event: "action",
      outcome: "executed",
      authorization: { path: "operator", approval: "approved", waitMs: 5 },
    });
  });

  it("gives every bridge (connection) its own session", async () => {
    const { events, recorder } = tracing();
    const a = new ModelFacingMcpBridge(invoker(["browser.observe"]), { trace: recorder });
    const b = new ModelFacingMcpBridge(invoker(["browser.observe"]), { trace: recorder });

    await a.callTool("browser.observe", {});
    await b.callTool("browser.observe", {});

    expect(events[0]!.runId).toBe(events[1]!.runId);
    expect(events[0]!.sessionId).not.toBe(events[1]!.sessionId);
    expect(events.map((event) => event.seq)).toEqual([1, 1]);
  });
});
