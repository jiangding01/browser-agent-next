import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  BrowserObservation,
  VerificationSpec,
} from "@browser-agent-next/core";
import {
  TrustedRuntimeHttpClient,
  type TrustedActBrokerRuntimeClient,
  readTrustedRpcToken,
} from "./trustedRuntimeClient.js";

const TOKEN = "a".repeat(64);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
});

function observation(): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "",
      url: "https://allowed.test/",
      origin: "https://allowed.test",
      ownedBySession: true,
    },
    revision: {
      id: "rev-1",
      stateEpoch: "state-1",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      forms: {
        status: "complete",
        returned: 0,
        totalKnown: 0,
      },
      text: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      frames: {
        discovered: 1,
        accessible: 1,
        degraded: [],
      },
      shadowDom: {
        openRootsCovered: true,
        closedRootsUnknown: true,
      },
      canvas: {
        present: false,
        semanticallyCovered: false,
      },
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
      url: "https://allowed.test/",
      documentEpoch: "doc-1",
      accessible: true,
    }],
    elements: [{
      ref: "@save",
      kind: "element",
      semantic: {
        role: "button",
        name: "Save",
      },
      state: {
        visible: true,
        enabled: true,
        focused: false,
      },
      frameId: "web:0",
      capabilities: [{ kind: "click" }],
      provenance: { dom: true },
    }],
  };
}

function successResponse(
  requestId: string,
  result: unknown,
): Response {
  return new Response(
    JSON.stringify({
      type: "trusted-host.result",
      requestId,
      ok: true,
      result,
    }),
    { status: 200 },
  );
}

describe("TrustedRuntimeHttpClient", () => {
  it("只构造 browser.open / browser.observe，携带 bearer 且禁止 redirect", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit;
      body: Record<string, unknown>;
    }> = [];

    const fetchImpl: typeof fetch =
      async (input, init) => {
        const body = JSON.parse(
          String(init?.body),
        ) as Record<string, unknown>;
        calls.push({
          url: String(input),
          init: init ?? {},
          body,
        });

        return successResponse(
          String(body.requestId),
          body.type === "browser.open"
            ? {
                tabId: 9,
                requestedUrl: body.url,
                ownedBySession: true,
              }
            : observation(),
        );
      };

    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl,
        requestId: () => "req-fixed",
      });

    await client.open({
      url: "https://allowed.test/",
      active: false,
    });
    await client.observe({
      tabId: 7,
      sinceRevision: "rev-0",
      options: {
        profile: "hybrid",
        maxElements: 100,
      },
    });

    expect(calls[0]).toMatchObject({
      url:
        "http://127.0.0.1:17366/trusted",
      init: {
        method: "POST",
        redirect: "error",
      },
      body: {
        type: "browser.open",
        requestId: "req-fixed",
        url: "https://allowed.test/",
        active: false,
      },
    });
    expect(
      (calls[0]?.init.headers as
        Record<string, string>)
        .authorization,
    ).toBe("Bearer " + TOKEN);

    expect(calls[1]?.body).toEqual({
      type: "browser.observe",
      requestId: "req-fixed",
      tabId: 7,
      sinceRevision: "rev-0",
      options: {
        profile: "hybrid",
        maxElements: 100,
      },
    });
  });

  it("拒绝非 loopback host", () => {
    expect(
      () =>
        new TrustedRuntimeHttpClient({
          token: TOKEN,
          host: "example.com",
        }),
    ).toThrow(/loopback/);
  });

  it("response requestId 不匹配时 fail closed", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "expected",
        fetchImpl: async () =>
          successResponse(
            "wrong",
            observation(),
          ),
      });

    await expect(
      client.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("open 的传输失败视为 ambiguous outcome，observe 则视为 state incomplete", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl: async () => {
          throw new Error("connection lost");
        },
      });

    await expect(
      client.open({
        url: "https://allowed.test/",
      }),
    ).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
    });

    await expect(
      client.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("trusted Runtime 已知错误码保持语义，未知错误码不透传", async () => {
    const known =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-known",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-known",
            ok: false,
            error: {
              code: "ORIGIN_NOT_ALLOWED",
              message: "blocked",
            },
          }), { status: 200 }),
      });

    await expect(
      known.open({
        url: "https://blocked.test/",
      }),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      message: "blocked",
    });

    const unknown =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-unknown",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-unknown",
            ok: false,
            error: {
              code: "SOMETHING_NEW",
              message: "internal detail",
            },
          }), { status: 200 }),
      });

    await expect(
      unknown.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
      message:
        "trusted Runtime returned an unknown error code",
    });
  });

  it("malformed observation 与超大 response 都拒绝进入 model adapter", async () => {
    const malformed =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-malformed",
        fetchImpl: async () =>
          successResponse(
            "req-malformed",
            {
              schemaVersion: 1,
              tab: { tabId: 7 },
            },
          ),
      });

    await expect(
      malformed.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });

    const oversized =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        maxResponseBytes: 1_024,
        requestId: () => "req-large",
        fetchImpl: async () =>
          new Response(
            "x".repeat(2_048),
            { status: 200 },
          ),
      });

    await expect(
      oversized.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("MCP 侧只读 secure token，不创建、不接受 symlink 或宽权限", () => {
    const dir = mkdtempSync(
      join(
        tmpdir(),
        "browser-agent-next-mcp-token-",
      ),
    );
    dirs.push(dir);
    chmodSync(dir, 0o700);

    const tokenPath = join(
      dir,
      "trusted-rpc.token",
    );
    writeFileSync(
      tokenPath,
      TOKEN,
      { mode: 0o600 },
    );

    expect(
      readTrustedRpcToken(tokenPath),
    ).toBe(TOKEN);

    if (process.platform !== "win32") {
      chmodSync(tokenPath, 0o644);
      expect(
        () =>
          readTrustedRpcToken(
            tokenPath,
          ),
      ).toThrow(/permissions/);
      chmodSync(tokenPath, 0o600);

      const target = join(
        dir,
        "target.token",
      );
      writeFileSync(
        target,
        TOKEN,
        { mode: 0o600 },
      );
      const link = join(
        dir,
        "link.token",
      );
      symlinkSync(target, link);

      expect(
        () =>
          readTrustedRpcToken(link),
      ).toThrow(/symlink/);
    }
  });
});

const VERIFICATION: VerificationSpec = {
  mode: "all",
  conditions: [
    { type: "ref_visible", ref: "@done" },
    { type: "text_present", text: "Saved" },
  ],
};

const ACT_INPUT = {
  tabId: 7,
  actionId: "action-1",
  observedRevision: "rev-1",
  ref: "@save",
  authorizationId: "auth-1",
  verification: VERIFICATION,
} as const;

const GRANT_INPUT = {
  authorizationId: "auth-1",
  tabId: 7,
  observedRevision: "rev-1",
  ref: "@save",
  ttlMs: 30_000,
} as const;

function actResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    execution: {
      actionId: "action-1",
      status: "executed",
      observedRevision: "rev-1",
      ref: "@save",
      effect: { kind: "click" },
    },
    verification: {
      verified: true,
      conclusive: true,
      revision: "rev-2",
      evidence: [
        {
          condition: {
            type: "ref_visible",
            ref: "@done",
          },
          pass: true,
          conclusive: true,
          observed: true,
        },
        {
          condition: {
            type: "text_present",
            text: "Saved",
          },
          pass: true,
          conclusive: true,
          reason: "found",
        },
      ],
    },
    verificationAttempts: 2,
    freshRevision: "rev-2",
    postActionObservationError: "boom",
    ...overrides,
  };
}

function respondWith(
  result: unknown,
  calls: Array<Record<string, unknown>> = [],
): TrustedRuntimeHttpClient {
  return new TrustedRuntimeHttpClient({
    token: TOKEN,
    requestId: () => "req-fixed",
    fetchImpl: async (_input, init) => {
      calls.push(
        JSON.parse(String(init?.body)) as
          Record<string, unknown>,
      );
      return successResponse(
        "req-fixed",
        result,
      );
    },
  });
}

describe("TrustedRuntimeHttpClient act broker 四方法", () => {
  it("实现 TrustedActBrokerRuntimeClient，且只发送各自的 trusted type 与精确字段", async () => {
    const calls: Array<
      Record<string, unknown>
    > = [];
    const client: TrustedActBrokerRuntimeClient =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-fixed",
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(
            String(init?.body),
          ) as Record<string, unknown>;
          calls.push(body);

          switch (body.type) {
            case "browser.act":
              return successResponse(
                "req-fixed",
                actResult(),
              );
            case "authorization.issue-strict-click":
              return successResponse(
                "req-fixed",
                {
                  id: "auth-1",
                  expiresAt: 1_000,
                  origin: "https://allowed.test",
                  assurance: "control-plane",
                },
              );
            case "authorization.request-operator-approval":
              return successResponse(
                "req-fixed",
                {
                  approvalRequestId: "operator-1",
                  authorizationId: "auth-1",
                  expiresAt: 2_000,
                  origin: "https://allowed.test",
                  pageTitle: "Page",
                  targetRole: "button",
                },
              );
            default:
              return successResponse(
                "req-fixed",
                {
                  approvalRequestId: "operator-1",
                  state: "approved",
                  authorizationId: "auth-1",
                  resolvedAt: 1_500,
                  grantExpiresAt: 3_000,
                },
              );
          }
        },
      });

    await client.act({
      ...ACT_INPUT,
      verifyTimeoutMs: 1_000,
    });
    await client.issueStrictClick(
      GRANT_INPUT,
    );
    await client.requestOperatorApproval(
      GRANT_INPUT,
    );
    await client.operatorApprovalStatus(
      "operator-1",
    );

    expect(calls).toEqual([
      {
        type: "browser.act",
        requestId: "req-fixed",
        tabId: 7,
        action: {
          kind: "click",
          actionId: "action-1",
          observedRevision: "rev-1",
          ref: "@save",
          authorizationId: "auth-1",
        },
        verification: VERIFICATION,
        verifyTimeoutMs: 1_000,
      },
      {
        type: "authorization.issue-strict-click",
        requestId: "req-fixed",
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@save",
        ttlMs: 30_000,
      },
      {
        type: "authorization.request-operator-approval",
        requestId: "req-fixed",
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@save",
        ttlMs: 30_000,
      },
      {
        type: "authorization.operator-approval-status",
        requestId: "req-fixed",
        approvalRequestId: "operator-1",
      },
    ]);
  });

  it("act 省略 verifyTimeoutMs 时不发送该字段", async () => {
    const calls: Array<
      Record<string, unknown>
    > = [];
    await respondWith(
      actResult(),
      calls,
    ).act(ACT_INPUT);

    expect(calls[0]).not.toHaveProperty(
      "verifyTimeoutMs",
    );
  });

  it("act 只返回 status / verification / verificationAttempts，丢弃 freshRevision 与 postActionObservationError", async () => {
    const result = await respondWith(
      actResult(),
    ).act(ACT_INPUT);

    expect(Object.keys(result).sort())
      .toEqual([
        "status",
        "verification",
        "verificationAttempts",
      ]);
    expect(result).toMatchObject({
      status: "executed",
      verificationAttempts: 2,
      verification: {
        verified: true,
        conclusive: true,
        revision: "rev-2",
      },
    });
    expect(JSON.stringify(result))
      .not.toMatch(
        /freshRevision|postActionObservationError|execution|effect/,
      );
  });

  it("act 的 verification evidence 丢弃未投影的 observed 原值", async () => {
    const result = await respondWith(
      actResult(),
    ).act(ACT_INPUT);

    expect(result.verification.evidence).toHaveLength(2);
    for (const evidence of result.verification.evidence) {
      expect(evidence).not.toHaveProperty("observed");
    }
  });

  it("act 的 verification 只保留已知字段，丢弃 evidence 里的多余键", async () => {
    const result = await respondWith(
      actResult({
        verification: {
          verified: false,
          conclusive: false,
          secret: "x",
          evidence: [{
            condition: {
              type: "ref_exists",
              ref: "@a",
              extra: 1,
            },
            pass: false,
            conclusive: false,
            leaked: "x",
          }],
        },
      }),
    ).act(ACT_INPUT);

    expect(result.verification).toEqual({
      verified: false,
      conclusive: false,
      evidence: [{
        condition: {
          type: "ref_exists",
          ref: "@a",
        },
        pass: false,
        conclusive: false,
      }],
    });
  });

  it("act 的每种 condition 类型都能通过校验", async () => {
    const conditions = [
      { type: "url_matches", pattern: "^https://" },
      { type: "title_matches", pattern: "Done" },
      { type: "ref_exists", ref: "@a" },
      { type: "ref_visible", ref: "@a" },
      { type: "ref_absent", ref: "@a" },
      {
        type: "text_present",
        text: "hi",
        scopeRef: "@a",
      },
      {
        type: "field_value",
        ref: "@a",
        equals: "v",
      },
      { type: "dialog_present", title: "T" },
      { type: "dialog_present" },
      { type: "download_started" },
      {
        type: "download_started",
        filenamePattern: "\\.pdf$",
      },
      {
        type: "network_request_completed",
        urlPattern: "/api",
      },
    ];

    const result = await respondWith(
      actResult({
        verification: {
          verified: true,
          conclusive: true,
          evidence: conditions.map(
            (condition) => ({
              condition,
              pass: true,
              conclusive: true,
            }),
          ),
        },
      }),
    ).act(ACT_INPUT);

    expect(
      result.verification.evidence
        .map((item) => item.condition),
    ).toEqual(conditions);
  });

  it.each([
    ["缺少 execution", { execution: undefined }],
    [
      "execution.status 不是 executed",
      { execution: { status: "failed" } },
    ],
    [
      "缺少 verification",
      { verification: undefined },
    ],
    [
      "缺少 verificationAttempts",
      { verificationAttempts: undefined },
    ],
    [
      "verificationAttempts 为负数",
      { verificationAttempts: -1 },
    ],
    [
      "verificationAttempts 非整数",
      { verificationAttempts: 1.5 },
    ],
    [
      "verificationAttempts 超界",
      { verificationAttempts: 10_001 },
    ],
    [
      "verified 不是 boolean",
      {
        verification: {
          verified: "yes",
          conclusive: true,
          evidence: [],
        },
      },
    ],
    [
      "evidence 不是数组",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: {},
        },
      },
    ],
    [
      "evidence 条数过多",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: Array.from(
            { length: 21 },
            () => ({
              condition: {
                type: "ref_exists",
                ref: "@a",
              },
              pass: true,
              conclusive: true,
            }),
          ),
        },
      },
    ],
    [
      "evidence 缺少 pass",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [{
            condition: {
              type: "ref_exists",
              ref: "@a",
            },
            conclusive: true,
          }],
        },
      },
    ],
    [
      "condition 类型未知",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [{
            condition: { type: "eval" },
            pass: true,
            conclusive: true,
          }],
        },
      },
    ],
    [
      "condition 字符串超长",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [{
            condition: {
              type: "url_matches",
              pattern: "x".repeat(2_049),
            },
            pass: true,
            conclusive: true,
          }],
        },
      },
    ],
    [
      "condition.ref 超长",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [{
            condition: {
              type: "ref_exists",
              ref: "r".repeat(257),
            },
            pass: true,
            conclusive: true,
          }],
        },
      },
    ],
    [
      "reason 超长",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [{
            condition: {
              type: "ref_exists",
              ref: "@a",
            },
            pass: true,
            conclusive: true,
            reason: "x".repeat(2_049),
          }],
        },
      },
    ],
    [
      "revision 超长",
      {
        verification: {
          verified: true,
          conclusive: true,
          evidence: [],
          revision: "r".repeat(257),
        },
      },
    ],
  ])(
    "act 响应异形（%s）映射为 ACTION_OUTCOME_UNKNOWN",
    async (_name, overrides) => {
      await expect(
        respondWith(
          actResult(overrides),
        ).act(ACT_INPUT),
      ).rejects.toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
      });
    },
  );

  it("act 的 result 不是对象时映射为 ACTION_OUTCOME_UNKNOWN", async () => {
    for (const result of [null, "ok", []]) {
      await expect(
        respondWith(result).act(ACT_INPUT),
      ).rejects.toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
      });
    }
  });

  it("issueStrictClick 只返回 id / expiresAt，丢弃 origin 与多余的 assurance", async () => {
    const result = await respondWith({
      id: "auth-1",
      expiresAt: 1_000,
      origin: "https://allowed.test",
      assurance: "enterprise-policy",
      extra: "x",
    }).issueStrictClick(GRANT_INPUT);

    expect(result).toEqual({
      id: "auth-1",
      expiresAt: 1_000,
    });
  });

  it.each([
    ["缺少 id", { expiresAt: 1_000 }],
    ["缺少 expiresAt", { id: "auth-1" }],
    [
      "id 与请求的 authorizationId 不一致",
      { id: "auth-other", expiresAt: 1_000 },
    ],
    [
      "id 超长",
      {
        id: "a".repeat(257),
        expiresAt: 1_000,
      },
    ],
    [
      "expiresAt 不是数字",
      { id: "auth-1", expiresAt: "soon" },
    ],
    [
      "expiresAt 为负数",
      { id: "auth-1", expiresAt: -1 },
    ],
    ["result 为 null", null],
  ])(
    "issueStrictClick 响应异形（%s）映射为 AUTHORIZATION_REQUIRED",
    async (_name, result) => {
      await expect(
        respondWith(result)
          .issueStrictClick(
            { ...GRANT_INPUT },
          ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    },
  );

  it("requestOperatorApproval 传入 approvalTtlMs 时请求体携带该字段，省略时不带该 key", async () => {
    const calls: Array<
      Record<string, unknown>
    > = [];
    const client = respondWith(
      {
        approvalRequestId: "operator-1",
        expiresAt: 2_000,
      },
      calls,
    );

    await client.requestOperatorApproval(
      GRANT_INPUT,
      45_000,
    );
    await client.requestOperatorApproval(
      GRANT_INPUT,
    );

    expect(calls).toEqual([
      {
        type: "authorization.request-operator-approval",
        requestId: "req-fixed",
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@save",
        ttlMs: 30_000,
        approvalTtlMs: 45_000,
      },
      {
        type: "authorization.request-operator-approval",
        requestId: "req-fixed",
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@save",
        ttlMs: 30_000,
      },
    ]);
    expect("approvalTtlMs" in calls[1]!).toBe(false);
  });

  it("cancelStrictClick 只发送 type 与 authorizationId，回显一致时 resolve", async () => {
    const calls: Array<
      Record<string, unknown>
    > = [];
    const client: TrustedActBrokerRuntimeClient =
      respondWith(
        {
          authorizationId: "auth-1",
          cancelled: true,
          origin: "https://allowed.test",
        },
        calls,
      );

    await expect(
      client.cancelStrictClick("auth-1"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        type: "authorization.cancel-strict-click",
        requestId: "req-fixed",
        authorizationId: "auth-1",
      },
    ]);
  });

  it.each([
    [
      "回显的 authorizationId 不一致",
      { authorizationId: "auth-other" },
    ],
    ["缺少 authorizationId", { cancelled: true }],
    ["result 为字符串", "auth-1"],
    ["result 为 null", null],
    ["result 为数组", ["auth-1"]],
  ])(
    "cancelStrictClick 响应异形（%s）映射为 malformed AUTHORIZATION_REQUIRED",
    async (_name, result) => {
      await expect(
        respondWith(result)
          .cancelStrictClick("auth-1"),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
        message: expect.stringContaining(
          "malformed authorization.cancel-strict-click",
        ),
      });
    },
  );

  it("requestOperatorApproval 只返回 approvalRequestId / expiresAt", async () => {
    const result = await respondWith({
      approvalRequestId: "operator-1",
      authorizationId: "auth-1",
      tabId: 7,
      origin: "https://allowed.test",
      pageTitle: "Page",
      targetRole: "button",
      requestedAt: 1,
      expiresAt: 2_000,
      authorizationTtlMs: 30_000,
      assurance: "operator-approved",
    }).requestOperatorApproval(GRANT_INPUT);

    expect(result).toEqual({
      approvalRequestId: "operator-1",
      expiresAt: 2_000,
    });
  });

  it.each([
    [
      "缺少 approvalRequestId",
      { expiresAt: 2_000 },
    ],
    [
      "缺少 expiresAt",
      { approvalRequestId: "operator-1" },
    ],
    [
      "approvalRequestId 超长",
      {
        approvalRequestId: "o".repeat(257),
        expiresAt: 2_000,
      },
    ],
    [
      "approvalRequestId 为空串",
      {
        approvalRequestId: "",
        expiresAt: 2_000,
      },
    ],
    [
      "回显的 authorizationId 不一致",
      {
        approvalRequestId: "operator-1",
        authorizationId: "auth-other",
        expiresAt: 2_000,
      },
    ],
    [
      "expiresAt 非整数",
      {
        approvalRequestId: "operator-1",
        expiresAt: 1.5,
      },
    ],
    ["result 为字符串", "approved"],
  ])(
    "requestOperatorApproval 响应异形（%s）映射为 AUTHORIZATION_REQUIRED",
    async (_name, result) => {
      await expect(
        respondWith(result)
          .requestOperatorApproval(
            GRANT_INPUT,
          ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    },
  );

  it.each([
    "pending",
    "approved",
    "rejected",
    "expired",
    "invalidated",
    "cancelled",
    "unknown",
  ])(
    "operatorApprovalStatus 支持 state=%s",
    async (state) => {
      const result = await respondWith({
        approvalRequestId: "operator-1",
        state,
      }).operatorApprovalStatus(
        "operator-1",
      );

      expect(result).toEqual({ state });
    },
  );

  it("operatorApprovalStatus 返回 grantExpiresAt，丢弃 authorizationId / resolvedAt / 多余 assurance", async () => {
    const result = await respondWith({
      approvalRequestId: "operator-1",
      state: "approved",
      authorizationId: "auth-1",
      resolvedAt: 1_500,
      grantExpiresAt: 3_000,
      assurance: "enterprise-policy",
    }).operatorApprovalStatus(
      "operator-1",
    );

    expect(result).toEqual({
      state: "approved",
      grantExpiresAt: 3_000,
    });
  });

  it.each([
    [
      "缺少 state",
      { approvalRequestId: "operator-1" },
    ],
    [
      "state 不在枚举内",
      {
        approvalRequestId: "operator-1",
        state: "granted",
      },
    ],
    [
      "state 不是字符串",
      {
        approvalRequestId: "operator-1",
        state: 1,
      },
    ],
    [
      "approvalRequestId 与请求不一致",
      {
        approvalRequestId: "operator-other",
        state: "approved",
      },
    ],
    [
      "缺少 approvalRequestId",
      { state: "approved" },
    ],
    [
      "grantExpiresAt 不是数字",
      {
        approvalRequestId: "operator-1",
        state: "approved",
        grantExpiresAt: "later",
      },
    ],
    [
      "resolvedAt 为负数",
      {
        approvalRequestId: "operator-1",
        state: "approved",
        resolvedAt: -5,
      },
    ],
    [
      "authorizationId 超长",
      {
        approvalRequestId: "operator-1",
        state: "approved",
        authorizationId: "a".repeat(257),
      },
    ],
    ["result 为 null", null],
  ])(
    "operatorApprovalStatus 响应异形（%s）映射为 AUTHORIZATION_REQUIRED",
    async (_name, result) => {
      await expect(
        respondWith(result)
          .operatorApprovalStatus(
            "operator-1",
          ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    },
  );

  it("四个方法的 response requestId 不匹配与传输失败按各自映射 fail closed", async () => {
    const mismatched =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "expected",
        fetchImpl: async () =>
          successResponse("wrong", {}),
      });
    const broken =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl: async () => {
          throw new Error("connection lost");
        },
      });

    for (const client of [mismatched, broken]) {
      await expect(
        client.act(ACT_INPUT),
      ).rejects.toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
      });
      await expect(
        client.issueStrictClick(
          GRANT_INPUT,
        ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
      await expect(
        client.requestOperatorApproval(
          GRANT_INPUT,
        ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
      await expect(
        client.operatorApprovalStatus(
          "operator-1",
        ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    }
  });

  it("HTTP 5xx 与非 JSON / 超大响应按各自映射", async () => {
    const serverError =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl: async () =>
          new Response("oops", {
            status: 500,
          }),
      });
    const oversized =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        maxResponseBytes: 1_024,
        fetchImpl: async () =>
          new Response(
            "x".repeat(2_048),
            { status: 200 },
          ),
      });

    for (const client of [serverError, oversized]) {
      await expect(
        client.act(ACT_INPUT),
      ).rejects.toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
      });
      await expect(
        client.issueStrictClick(
          GRANT_INPUT,
        ),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    }
  });

  it("trusted 错误带 outcomeMayHaveChanged 时，四个方法都映射为 ACTION_OUTCOME_UNKNOWN（优先于已知 code）", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-ambiguous",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-ambiguous",
            ok: false,
            error: {
              code: "AUTHORIZATION_REQUIRED",
              message: "may have changed",
              outcomeMayHaveChanged: true,
            },
          }), { status: 200 }),
      });

    const calls = [
      () => client.act(ACT_INPUT),
      () =>
        client.issueStrictClick(
          GRANT_INPUT,
        ),
      () =>
        client.requestOperatorApproval(
          GRANT_INPUT,
        ),
      () =>
        client.operatorApprovalStatus(
          "operator-1",
        ),
    ];

    for (const call of calls) {
      await expect(call()).rejects
        .toMatchObject({
          code: "ACTION_OUTCOME_UNKNOWN",
          message: "may have changed",
        });
    }
  });

  it("outcomeMayHaveChanged=false 时仍按已知 runtime code 白名单透传", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-known",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-known",
            ok: false,
            error: {
              code: "OBSERVATION_EXPIRED",
              message: "gone",
              outcomeMayHaveChanged: false,
            },
          }), { status: 200 }),
      });

    await expect(
      client.act(ACT_INPUT),
    ).rejects.toMatchObject({
      code: "OBSERVATION_EXPIRED",
      message: "gone",
    });
    await expect(
      client.issueStrictClick(
        GRANT_INPUT,
      ),
    ).rejects.toMatchObject({
      code: "OBSERVATION_EXPIRED",
    });
  });

  it("未知 runtime code 按操作映射：act 为 ACTION_OUTCOME_UNKNOWN，authorize 为 AUTHORIZATION_REQUIRED，且不透传原文", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-unknown",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-unknown",
            ok: false,
            error: {
              code: "SOMETHING_NEW",
              message: "internal detail",
            },
          }), { status: 200 }),
      });

    await expect(
      client.act(ACT_INPUT),
    ).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
      message:
        "trusted Runtime returned an unknown error code",
    });
    await expect(
      client.operatorApprovalStatus(
        "operator-1",
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
      message:
        "trusted Runtime returned an unknown error code",
    });
  });

  it.each([400, 401, 404, 413])(
    "HTTP %i 对新方法同样映射为 POLICY_BLOCKED（现有行为不变）",
    async (status) => {
      const client =
        new TrustedRuntimeHttpClient({
          token: TOKEN,
          fetchImpl: async () =>
            new Response("", { status }),
        });

      for (const call of [
        () => client.act(ACT_INPUT),
        () =>
          client.issueStrictClick(
            GRANT_INPUT,
          ),
        () =>
          client.requestOperatorApproval(
            GRANT_INPUT,
          ),
        () =>
          client.operatorApprovalStatus(
            "operator-1",
          ),
        () => client.observe({ tabId: 7 }),
        () =>
          client.open({
            url: "https://allowed.test/",
          }),
      ]) {
        await expect(call()).rejects
          .toMatchObject({
            code: "POLICY_BLOCKED",
            message:
              "trusted Runtime rejected the request with HTTP " +
              status,
          });
      }
    },
  );

  it("新方法同样携带 bearer、禁止 redirect", async () => {
    let captured: RequestInit | undefined;
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-fixed",
        fetchImpl: async (_input, init) => {
          captured = init;
          return successResponse(
            "req-fixed",
            actResult(),
          );
        },
      });

    await client.act(ACT_INPUT);

    expect(captured).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(
      (captured?.headers as
        Record<string, string>)
        .authorization,
    ).toBe("Bearer " + TOKEN);
  });
});
