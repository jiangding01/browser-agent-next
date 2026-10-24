import {
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type {
  BrowserObservation,
} from "@browser-agent-next/core";
import {
  MODEL_FACING_DEFAULT_TOOL_NAMES,
} from "@browser-agent-next/policy";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  createModelFacingInvoker,
} from "./cli.js";
import {
  MCP_CONFIG_ENV,
  loadModelFacingMcpConfig,
} from "./mcpConfig.js";
import {
  serveModelFacingMcpStdio,
} from "./mcpProtocolServer.js";
import {
  MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
  MODEL_ACT_GRANT_TTL_MS,
} from "./modelActBroker.js";
import type {
  TrustedOperatorApprovalState,
} from "./trustedRuntimeClient.js";
import {
  makeButton,
  makeObservation,
  startFakeTrustedRuntime,
  type FakeTrustedHandler,
  type FakeTrustedReply,
  type FakeTrustedRequest,
  type FakeTrustedRuntime,
} from "./testing/fakeTrustedRuntime.js";
import {
  collectUntilResponse,
  createWire,
  initializeWire,
  resultOf,
  toolPayload,
  type JsonRpcMessage,
} from "./testing/mcpWire.js";

/**
 * Phase 6.6c：wire 级 side-effect 集成测试。
 *
 * 真实 MCP JSON-RPC wire（SDK StdioServerTransport + 内存 pipe）
 * + 真实 CLI 组装（loadModelFacingMcpConfig + createModelFacingInvoker：
 *   adapter + broker + TrustedRuntimeHttpClient）
 * + 真实 HTTP（127.0.0.1 随机端口上的假 trusted RPC 服务）。
 *
 * broker 的审批轮询是真实 1 s sleep（CLI 组装不注入时钟），
 * 因此走授权路径的用例都显式放宽 timeout。
 */

const TOKEN = "5e1f0c9a".repeat(8);
const ORIGIN_A = "https://a.test";
const ORIGIN_B = "https://b.test";
const PAGE_A = ORIGIN_A + "/page";
const PAGE_B = ORIGIN_B + "/page";
const SECRET = "SECRET-6c-wire-4d2f9b";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ACT_TEST_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 10_000;

type Env = Record<string, string>;

interface Script {
  /** 默认：PAGE_A 顶层 frame 中的 `@save` 按钮。 */
  observe?: (
    tabId: number,
    revision: string,
  ) => BrowserObservation;
  /** 每次 status 调用依次取一个，取完后重复最后一个。默认首轮即 approved。 */
  approvalStates?: readonly TrustedOperatorApprovalState[];
  act?: FakeTrustedHandler;
  /** 合并进所有 authorization.* 成功结果的额外字段（出境脱敏用例）。 */
  authorizationExtra?: Record<string, unknown>;
  /** 按 type 覆盖默认 handler（读路径错误原文用例）。 */
  handlers?: Partial<Record<string, FakeTrustedHandler>>;
}

function actSuccess(
  request: FakeTrustedRequest,
  secret?: string,
): FakeTrustedReply {
  const action = request.action as Record<string, unknown>;
  const verification = request.verification as {
    conditions: unknown[];
  };

  return {
    ok: true,
    result: {
      execution: {
        actionId: action.actionId,
        status: "executed",
        observedRevision: action.observedRevision,
        ref: action.ref,
        effect: {
          effectClass: "unknown",
          ...(secret !== undefined ? { evidence: secret } : {}),
        },
      },
      verification: {
        verified: true,
        conclusive: true,
        evidence: verification.conditions.map((condition) => ({
          condition,
          pass: true,
          conclusive: true,
          ...(secret !== undefined
            ? { observed: secret, reason: secret }
            : {}),
        })),
        ...(secret !== undefined ? { revision: secret } : {}),
      },
      verificationAttempts: 1,
      ...(secret !== undefined
        ? {
            freshRevision: secret,
            postActionObservationError: secret,
          }
        : {}),
    },
  };
}

function scriptedHandlers(
  script: Script,
): Record<string, FakeTrustedHandler> {
  const observeSequence = new Map<number, number>();
  const states = script.approvalStates ?? ["approved"];
  const extra = script.authorizationExtra ?? {};
  let approvalRequests = 0;
  let statusCalls = 0;

  return {
    "browser.open": (request) => ({
      ok: true,
      result: {
        tabId: 1,
        requestedUrl: request.url,
        ownedBySession: true,
      },
    }),
    "browser.observe": (request) => {
      const tabId = request.tabId as number;
      const sequence = (observeSequence.get(tabId) ?? 0) + 1;
      observeSequence.set(tabId, sequence);
      const revision = "rev-" + tabId + "-" + sequence;

      return {
        ok: true,
        result: script.observe
          ? script.observe(tabId, revision)
          : makeObservation({ tabId, revision, url: PAGE_A }),
      };
    },
    "authorization.issue-strict-click": (request) => ({
      ok: true,
      result: {
        ...extra,
        id: request.authorizationId,
        expiresAt: Date.now() + 30_000,
      },
    }),
    "authorization.request-operator-approval": (request) => {
      approvalRequests += 1;
      return {
        ok: true,
        result: {
          ...extra,
          approvalRequestId: "approval-" + approvalRequests,
          authorizationId: request.authorizationId,
          expiresAt: Date.now() + 60_000,
        },
      };
    },
    "authorization.operator-approval-status": (request) => {
      const state =
        states[Math.min(statusCalls, states.length - 1)];
      statusCalls += 1;
      return {
        ok: true,
        result: {
          ...extra,
          approvalRequestId: request.approvalRequestId,
          state,
        },
      };
    },
    "authorization.cancel-strict-click": (request) => ({
      ok: true,
      result: {
        ...extra,
        authorizationId: request.authorizationId,
      },
    }),
    "browser.act": script.act ?? ((request) => actSuccess(request)),
    ...script.handlers,
  };
}

interface ToolCall {
  id: number;
  messages: JsonRpcMessage[];
  response: JsonRpcMessage;
  payload: Record<string, unknown>;
  isError: boolean;
}

async function startHarness(
  env: Env,
  script: Script = {},
) {
  const runtime = await startFakeTrustedRuntime({
    token: TOKEN,
    handlers: scriptedHandlers(script),
  });
  const config = loadModelFacingMcpConfig({
    [MCP_CONFIG_ENV.rpcHost]: runtime.host,
    [MCP_CONFIG_ENV.rpcPort]: String(runtime.port),
    ...env,
  });
  const wire = createWire();
  const errors: Error[] = [];
  const transport = new StdioServerTransport(
    wire.input,
    wire.output,
    { maxBufferSize: 64 * 1024 },
  );
  const handle = serveModelFacingMcpStdio(
    () => createModelFacingInvoker(config, TOKEN),
    {
      transport,
      legacy: "serve",
      maxResultBytes: config.mcpMaxResultBytes,
      onerror: (error) => {
        errors.push(error);
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  const initialized = await initializeWire(wire);
  expect(initialized.id).toBe(1);

  let nextId = 2;

  const send = (
    method: string,
    params: Record<string, unknown>,
  ): number => {
    const id = nextId;
    nextId += 1;
    wire.send({ jsonrpc: "2.0", id, method, params });
    return id;
  };

  const sendTool = (
    name: string,
    args: Record<string, unknown>,
    progressToken?: string,
  ): number =>
    send("tools/call", {
      name,
      arguments: args,
      ...(progressToken !== undefined
        ? { _meta: { progressToken } }
        : {}),
    });

  const finishTool = async (
    id: number,
  ): Promise<ToolCall> => {
    const messages = await collectUntilResponse(
      wire,
      id,
      RESPONSE_TIMEOUT_MS,
    );
    const response = messages[messages.length - 1]!;
    return {
      id,
      messages,
      response,
      payload: toolPayload(response),
      isError: resultOf(response).isError === true,
    };
  };

  return {
    runtime,
    wire,
    errors,
    send,
    sendTool,
    finishTool,
    callTool: (
      name: string,
      args: Record<string, unknown>,
      progressToken?: string,
    ) => finishTool(sendTool(name, args, progressToken)),
    async observe(tabId: number): Promise<BrowserObservation> {
      const call = await finishTool(
        sendTool("browser.observe", { tabId }),
      );
      expect(call.isError).toBe(false);
      return call.payload as unknown as BrowserObservation;
    },
    async close() {
      await handle.close();
      wire.close();
      await runtime.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof startHarness>>;

function actArgs(
  tabId: number,
  observedRevision: string,
  ref: string,
): Record<string, unknown> {
  return {
    tabId,
    observedRevision,
    ref,
    kind: "click",
    verification: {
      mode: "all",
      conditions: [{ type: "ref_exists", ref }],
    },
    // 模型侧本地验证只观察一次，保持用例耗时有界。
    verifyTimeoutMs: 0,
  };
}

function errorOf(call: ToolCall): { code: string; message: string } {
  expect(call.isError).toBe(true);
  expect(call.payload.ok).toBe(false);
  return call.payload.error as { code: string; message: string };
}

/** authorization.* 与 browser.act 的 RPC 数量（act 后本地验证的 observe 不计）。 */
function sideEffectRpcCount(runtime: FakeTrustedRuntime): number {
  return (
    runtime.withPrefix("authorization.").length +
    runtime.ofType("browser.act").length
  );
}

/** wire 输出不含 trusted token 与出境标记，且 transport 未报错。 */
function expectNoLeak(harness: Harness): void {
  expect(harness.errors).toEqual([]);
  const transcript = harness.wire.transcript();
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(TOKEN);
  expect(transcript).not.toContain(SECRET);
}

function actEnv(extra: Env = {}): Env {
  return {
    [MCP_CONFIG_ENV.readOrigins]: ORIGIN_A,
    [MCP_CONFIG_ENV.actOrigins]: ORIGIN_A,
    [MCP_CONFIG_ENV.tools]: "browser.observe,browser.act",
    [MCP_CONFIG_ENV.actApproval]: "operator",
    ...extra,
  };
}

describe("model-facing side-effect wire integration", () => {
  it(
    "默认工具集合不暴露 browser.act：tools/list 无 act，手工调用 POLICY_BLOCKED 且无授权 / act RPC",
    async () => {
      const harness = await startHarness({
        [MCP_CONFIG_ENV.readOrigins]: ORIGIN_A,
        [MCP_CONFIG_ENV.navigationOrigins]: ORIGIN_A,
        // 即使 operator 配置了 act origin，未显式暴露工具时 act 仍不可达。
        [MCP_CONFIG_ENV.actOrigins]: ORIGIN_A,
      });

      try {
        const listId = harness.send("tools/list", {});
        const [listed] = await collectUntilResponse(
          harness.wire,
          listId,
        );
        const names = (
          resultOf(listed!).tools as Array<{ name: string }>
        ).map((tool) => tool.name);
        expect(names).toEqual([...MODEL_FACING_DEFAULT_TOOL_NAMES]);
        expect(names).not.toContain("browser.act");

        const observation = await harness.observe(1);

        const blocked = await harness.callTool(
          "browser.act",
          actArgs(1, observation.revision.id, "@save"),
        );
        const error = errorOf(blocked);
        expect(error.code).toBe("POLICY_BLOCKED");
        expect(error.message).toContain("browser.act");

        expect(harness.runtime.types()).toEqual([
          "browser.observe",
        ]);
        expect(sideEffectRpcCount(harness.runtime)).toBe(0);
        expect(harness.errors).toEqual([]);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
  );

  it(
    "operator 批准全链路：pending×2 产生 2 条 progress，act 携带 broker 生成的 authorizationId 与 verifyTimeoutMs 0",
    async () => {
      const harness = await startHarness(
        actEnv({
          [MCP_CONFIG_ENV.approvalTimeoutMs]: "30000",
        }),
        { approvalStates: ["pending", "pending", "approved"] },
      );

      try {
        const observation = await harness.observe(1);
        const revision = observation.revision.id;
        expect(
          observation.elements.map((element) => element.ref),
        ).toEqual(["@save"]);

        const call = await harness.callTool(
          "browser.act",
          actArgs(1, revision, "@save"),
          "act-progress-1",
        );

        expect(call.isError).toBe(false);
        expect(call.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
          verification: { verified: true, conclusive: true },
          verificationAttempts: 1,
        });

        const progress = call.messages.filter(
          (message) => message.method === "notifications/progress",
        );
        expect(progress.map((message) => message.params)).toEqual([
          {
            progressToken: "act-progress-1",
            progress: 1,
            message: MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
          },
          {
            progressToken: "act-progress-1",
            progress: 2,
            message: MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
          },
        ]);

        const runtime = harness.runtime;
        expect(runtime.types()).toEqual([
          "browser.observe",
          "authorization.request-operator-approval",
          "authorization.operator-approval-status",
          "authorization.operator-approval-status",
          "authorization.operator-approval-status",
          "browser.act",
          // act 后 adapter 在已出境 observation 上本地验证。
          "browser.observe",
        ]);

        const [approval] = runtime.ofType(
          "authorization.request-operator-approval",
        );
        expect(approval).toMatchObject({
          tabId: 1,
          observedRevision: revision,
          ref: "@save",
          ttlMs: MODEL_ACT_GRANT_TTL_MS,
          approvalTtlMs: 30_000,
        });
        const authorizationId = approval!.authorizationId as string;
        expect(authorizationId).toMatch(UUID);

        for (const status of runtime.ofType(
          "authorization.operator-approval-status",
        )) {
          expect(status.approvalRequestId).toBe("approval-1");
        }

        const [act] = runtime.ofType("browser.act");
        expect(act).toMatchObject({
          tabId: 1,
          action: {
            kind: "click",
            observedRevision: revision,
            ref: "@save",
            authorizationId,
          },
          verification: {
            mode: "all",
            conditions: [{ type: "ref_exists", ref: "@save" }],
          },
          verifyTimeoutMs: 0,
        });
        const actionId = (act!.action as { actionId: string })
          .actionId;
        expect(actionId).toMatch(UUID);
        expect(actionId).not.toBe(authorizationId);

        expect(
          runtime.ofType("authorization.cancel-strict-click"),
        ).toEqual([]);
        expect(harness.errors).toEqual([]);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "出境脱敏：act 结果与授权响应中的标记（observed / freshRevision / postActionObservationError 等）不出现在 wire 上",
    async () => {
      const harness = await startHarness(actEnv(), {
        act: (request) => actSuccess(request, SECRET),
        authorizationExtra: { note: SECRET },
      });

      try {
        const observation = await harness.observe(1);
        const call = await harness.callTool(
          "browser.act",
          actArgs(1, observation.revision.id, "@save"),
        );

        expect(call.isError).toBe(false);
        expect(Object.keys(call.payload).sort()).toEqual([
          "effectClass",
          "status",
          "verification",
          "verificationAttempts",
        ]);
        const verification = call.payload.verification as {
          evidence: Array<Record<string, unknown>>;
          revision?: string;
        };
        for (const evidence of verification.evidence) {
          expect(evidence).not.toHaveProperty("observed");
        }
        // 模型可见 revision 来自本地重算（已出境），而非扩展回传的 freshRevision。
        expect(verification.revision).toBe("rev-1-2");

        // 确认标记确实经过了授权与 act 路径。
        expect(
          harness.runtime.ofType(
            "authorization.request-operator-approval",
          ),
        ).toHaveLength(1);
        expect(harness.runtime.ofType("browser.act")).toHaveLength(1);
        expect(harness.errors).toEqual([]);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "运行时错误：TARGET_OCCLUDED 只保留 code、message 为固定文本，并撤销同一 authorizationId",
    async () => {
      const harness = await startHarness(actEnv(), {
        act: () => ({
          ok: false,
          error: {
            code: "TARGET_OCCLUDED",
            message: "target covered by " + SECRET,
          },
        }),
      });

      try {
        const observation = await harness.observe(1);
        const call = await harness.callTool(
          "browser.act",
          actArgs(1, observation.revision.id, "@save"),
        );

        const error = errorOf(call);
        expect(error.code).toBe("TARGET_OCCLUDED");
        expect(error.message).toBe(
          "trusted Runtime rejected browser.act execution: TARGET_OCCLUDED",
        );

        const runtime = harness.runtime;
        const [act] = runtime.ofType("browser.act");
        const authorizationId = (
          act!.action as { authorizationId: string }
        ).authorizationId;
        const cancels = runtime.ofType(
          "authorization.cancel-strict-click",
        );
        expect(cancels).toHaveLength(1);
        expect(cancels[0]!.authorizationId).toBe(authorizationId);
        expect(runtime.types().slice(-2)).toEqual([
          "browser.act",
          "authorization.cancel-strict-click",
        ]);
        expect(harness.errors).toEqual([]);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "客户端取消：审批 pending 时 notifications/cancelled → 撤销授权且从未发出 browser.act",
    async () => {
      const harness = await startHarness(actEnv(), {
        approvalStates: ["pending"],
      });

      try {
        const observation = await harness.observe(1);
        const actId = harness.sendTool(
          "browser.act",
          actArgs(1, observation.revision.id, "@save"),
          "act-cancel-1",
        );

        // 等到第一条 progress，确认已进入审批轮询。
        while (true) {
          const message = await harness.wire.next(
            RESPONSE_TIMEOUT_MS,
          );
          expect(message.id).toBeUndefined();
          if (message.method === "notifications/progress") break;
        }

        harness.wire.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: actId, reason: "user cancelled" },
        });

        const runtime = harness.runtime;
        await expect
          .poll(
            () =>
              runtime.ofType("authorization.cancel-strict-click")
                .length,
            { timeout: 5_000, interval: 50 },
          )
          .toBe(1);

        const [approval] = runtime.ofType(
          "authorization.request-operator-approval",
        );
        expect(
          runtime.ofType("authorization.cancel-strict-click")[0]!
            .authorizationId,
        ).toBe(approval!.authorizationId);

        // 越过一个轮询周期，确认取消后不再轮询、也不执行。
        const statusCalls = runtime.ofType(
          "authorization.operator-approval-status",
        ).length;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(
          runtime.ofType("authorization.operator-approval-status")
            .length,
        ).toBe(statusCalls);
        expect(runtime.ofType("browser.act")).toEqual([]);

        // 连接仍可用（不 await 被取消请求的响应）。
        const listId = harness.send("tools/list", {});
        const later = await collectUntilResponse(
          harness.wire,
          listId,
          RESPONSE_TIMEOUT_MS,
        );
        expect(later[later.length - 1]!.id).toBe(listId);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "per-connection 预算：budget=1 时第二次 act POLICY_BLOCKED 且无新的授权 / act RPC",
    async () => {
      const harness = await startHarness(
        actEnv({ [MCP_CONFIG_ENV.actBudget]: "1" }),
      );

      try {
        const first = await harness.observe(1);
        const executed = await harness.callTool(
          "browser.act",
          actArgs(1, first.revision.id, "@save"),
        );
        expect(executed.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
        });

        const second = await harness.observe(1);
        expect(second.revision.id).not.toBe(first.revision.id);
        const before = sideEffectRpcCount(harness.runtime);

        const blocked = await harness.callTool(
          "browser.act",
          actArgs(1, second.revision.id, "@save"),
        );
        const error = errorOf(blocked);
        expect(error.code).toBe("POLICY_BLOCKED");
        expect(error.message).toContain("budget");
        expect(sideEffectRpcCount(harness.runtime)).toBe(before);
        expect(harness.runtime.ofType("browser.act")).toHaveLength(1);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "单次执行：budget≥2 时同一 (tab, revision, ref) 的重复 act 被拒且无新的授权 / act RPC",
    async () => {
      const harness = await startHarness(
        actEnv({ [MCP_CONFIG_ENV.actBudget]: "2" }),
      );

      try {
        const observation = await harness.observe(1);
        const args = actArgs(1, observation.revision.id, "@save");

        const executed = await harness.callTool("browser.act", args);
        expect(executed.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
        });
        const before = sideEffectRpcCount(harness.runtime);

        const repeated = await harness.callTool("browser.act", args);
        const error = errorOf(repeated);
        expect(error.code).toBe("POLICY_BLOCKED");
        expect(error.message).toContain("already attempted");
        expect(sideEffectRpcCount(harness.runtime)).toBe(before);
        expect(harness.runtime.ofType("browser.act")).toHaveLength(1);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "origin / frame plane：非 act origin 与 B 子 frame 被拒、未出境 revision 被拒，about:blank 子 frame 继承 A 后允许",
    async () => {
      const harness = await startHarness(
        actEnv({
          [MCP_CONFIG_ENV.readOrigins]: ORIGIN_A + "," + ORIGIN_B,
          [MCP_CONFIG_ENV.actOrigins]: ORIGIN_A,
        }),
        {
          observe: (tabId, revision) =>
            tabId === 2
              ? makeObservation({ tabId, revision, url: PAGE_B })
              : makeObservation({
                  tabId,
                  revision,
                  url: PAGE_A,
                  frames: [
                    {
                      frameId: "web:0",
                      url: PAGE_A,
                      documentEpoch: "doc-top",
                      accessible: true,
                    },
                    {
                      frameId: "web:1",
                      parentFrameId: "web:0",
                      url: ORIGIN_B + "/frame",
                      documentEpoch: "doc-b",
                      accessible: true,
                    },
                    {
                      frameId: "web:2",
                      parentFrameId: "web:0",
                      url: "about:blank",
                      documentEpoch: "doc-blank",
                      accessible: true,
                    },
                  ],
                  elements: [
                    makeButton("@b-save", "web:1"),
                    makeButton("@blank-save", "web:2"),
                  ],
                }),
        },
      );

      try {
        const runtime = harness.runtime;

        // 顶层 tab 位于 B：B 可读但不可 act。
        const onB = await harness.observe(2);
        expect(onB.elements.map((element) => element.ref)).toEqual([
          "@save",
        ]);
        const topBlocked = await harness.callTool(
          "browser.act",
          actArgs(2, onB.revision.id, "@save"),
        );
        expect(errorOf(topBlocked).code).toBe("ORIGIN_NOT_ALLOWED");

        // 顶层 A，目标元素位于 url=B 的子 frame：已出境（B 可读）但不可 act。
        const onA = await harness.observe(1);
        expect(onA.elements.map((element) => element.ref)).toEqual([
          "@b-save",
          "@blank-save",
        ]);
        const frameBlocked = await harness.callTool(
          "browser.act",
          actArgs(1, onA.revision.id, "@b-save"),
        );
        expect(errorOf(frameBlocked).code).toBe("ORIGIN_NOT_ALLOWED");

        // 未出境的 revision。
        const unexposed = await harness.callTool(
          "browser.act",
          actArgs(1, "rev-1-999", "@blank-save"),
        );
        expect(errorOf(unexposed).code).toBe("MODEL_EGRESS_BLOCKED");

        expect(sideEffectRpcCount(runtime)).toBe(0);

        // about:blank 子 frame 继承顶层 A：允许并进入授权路径。
        const allowed = await harness.callTool(
          "browser.act",
          actArgs(1, onA.revision.id, "@blank-save"),
        );
        expect(allowed.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
        });
        const approvals = runtime.ofType(
          "authorization.request-operator-approval",
        );
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({
          tabId: 1,
          observedRevision: onA.revision.id,
          ref: "@blank-save",
        });
        expect(runtime.ofType("browser.act")).toHaveLength(1);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "降级：agent-owned-auto 下 act 结果未知后，同一 tab 的下一次 act 改走 operator approval",
    async () => {
      let actCalls = 0;
      const harness = await startHarness(
        actEnv({
          [MCP_CONFIG_ENV.actApproval]: "agent-owned-auto",
        }),
        {
          observe: (tabId, revision) =>
            makeObservation({
              tabId,
              revision,
              url: PAGE_A,
              ownedBySession: true,
            }),
          act: (request) => {
            actCalls += 1;
            return actCalls === 1
              ? {
                  ok: false,
                  error: {
                    code: "ACTION_OUTCOME_UNKNOWN",
                    message: "click may have happened: " + SECRET,
                    outcomeMayHaveChanged: true,
                  },
                }
              : actSuccess(request);
          },
        },
      );

      try {
        const runtime = harness.runtime;

        const first = await harness.observe(1);
        expect(first.tab.ownedBySession).toBe(true);
        const unknown = await harness.callTool(
          "browser.act",
          actArgs(1, first.revision.id, "@save"),
        );
        const error = errorOf(unknown);
        expect(error.code).toBe("ACTION_OUTCOME_UNKNOWN");
        expect(error.message).toBe(
          "trusted Runtime rejected browser.act execution: ACTION_OUTCOME_UNKNOWN",
        );
        expect(runtime.types()).toEqual([
          "browser.observe",
          "authorization.issue-strict-click",
          "browser.act",
          "authorization.cancel-strict-click",
        ]);

        const second = await harness.observe(1);
        expect(second.revision.id).not.toBe(first.revision.id);
        const executed = await harness.callTool(
          "browser.act",
          actArgs(1, second.revision.id, "@save"),
        );
        expect(executed.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
        });

        expect(
          runtime.ofType("authorization.issue-strict-click"),
        ).toHaveLength(1);
        const approvals = runtime.ofType(
          "authorization.request-operator-approval",
        );
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({
          tabId: 1,
          observedRevision: second.revision.id,
          ref: "@save",
        });
        expect(runtime.ofType("browser.act")).toHaveLength(2);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "trusted token 只出现在 HTTP Authorization 头：不出现在 wire 输出与 RPC body 中",
    async () => {
      const harness = await startHarness(
        actEnv({
          [MCP_CONFIG_ENV.navigationOrigins]: ORIGIN_A,
          [MCP_CONFIG_ENV.tools]:
            "browser.open,browser.observe,browser.act",
        }),
      );

      try {
        const opened = await harness.callTool("browser.open", {
          url: PAGE_A,
        });
        expect(opened.isError).toBe(false);
        expect(opened.payload).toMatchObject({ tabId: 1 });

        const observation = await harness.observe(1);
        const executed = await harness.callTool(
          "browser.act",
          actArgs(1, observation.revision.id, "@save"),
        );
        expect(executed.payload).toMatchObject({
          status: "executed",
          effectClass: "unknown",
        });

        const runtime = harness.runtime;
        expect(runtime.unauthorizedCount()).toBe(0);
        expect(runtime.types()).toContain("browser.open");
        expect(runtime.types()).toContain("browser.act");
        expect(JSON.stringify(runtime.requests)).not.toContain(TOKEN);
        expect(harness.wire.transcript()).not.toContain(TOKEN);
        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
    ACT_TEST_TIMEOUT_MS,
  );

  it(
    "读路径（open / observe / wait）的 trusted 错误原文不出境，只保留 code",
    async () => {
      const harness = await startHarness(
        {
          [MCP_CONFIG_ENV.readOrigins]: ORIGIN_A,
          [MCP_CONFIG_ENV.navigationOrigins]: ORIGIN_A,
          [MCP_CONFIG_ENV.tools]:
            "browser.open,browser.observe,browser.wait",
        },
        {
          handlers: {
            "browser.open": () => ({
              ok: false,
              error: {
                code: "ORIGIN_NOT_ALLOWED",
                message: SECRET + " " + PAGE_A,
              },
            }),
            "browser.observe": () => ({
              ok: false,
              error: {
                code: "DOCUMENT_CHANGED",
                message: SECRET + " page title",
              },
            }),
          },
        },
      );

      try {
        const opened = await harness.callTool("browser.open", {
          url: PAGE_A,
        });
        expect(errorOf(opened).code).toBe("ORIGIN_NOT_ALLOWED");

        const observed = await harness.callTool("browser.observe", {
          tabId: 1,
        });
        expect(errorOf(observed).code).toBe("DOCUMENT_CHANGED");

        // wait 会把 observe 失败写进模型可见的 lastObservationError。
        await harness.callTool("browser.wait", {
          tabId: 1,
          verification: {
            mode: "all",
            conditions: [{ type: "url_matches", pattern: PAGE_A }],
          },
          timeoutMs: 300,
          pollIntervalMs: 100,
        });
        expect(
          harness.runtime.ofType("browser.observe").length,
        ).toBeGreaterThan(1);

        expectNoLeak(harness);
      } finally {
        await harness.close();
      }
    },
  );
});
