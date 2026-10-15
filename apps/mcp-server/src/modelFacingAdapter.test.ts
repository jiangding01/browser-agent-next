import { describe, expect, it, vi } from "vitest";
import type {
  BrowserObservation,
  BrowserOpenInput,
  BrowserOpenResult,
  BrowserObserveInput,
  BrowserWaitResult,
  VerificationResult,
} from "@browser-agent-next/core";
import {
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
} from "@browser-agent-next/policy";
import {
  createModelActBroker,
  type ModelActBroker,
  type ModelActExecution,
} from "./modelActBroker.js";
import {
  MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS,
  ModelFacingBrowserAdapter,
  type ModelActResult,
  type ModelBrowserRuntimeClient,
} from "./modelFacingAdapter.js";
import type {
  TrustedActBrokerRuntimeClient,
} from "./trustedRuntimeClient.js";

function observation(
  revision = "rev-1",
  options: {
    topText?: string;
    childText?: string;
    fieldValue?: string;
  } = {},
): BrowserObservation {
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
      id: revision,
      stateEpoch: "runtime",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 3, totalKnown: 3 },
      forms: { status: "complete", returned: 1, totalKnown: 1 },
      text: { status: "complete", returned: 3, totalKnown: 3 },
      frames: { discovered: 2, accessible: 2, degraded: [] },
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
    frames: [
      {
        frameId: "web:0",
        url: "https://allowed.test/page",
        documentEpoch: "doc-1",
        accessible: true,
        degradedReason: "internal detail should not leak",
      },
      {
        frameId: "web:2",
        parentFrameId: "web:0",
        url: "https://blocked.test/embed",
        documentEpoch: "doc-child",
        accessible: true,
      },
    ],
    elements: [
      {
        ref: "@top",
        kind: "element",
        semantic: {
          role: "button",
          name: "Save",
          ...(options.topText ? { text: options.topText } : {}),
        },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
        provenance: { dom: true },
      },
      {
        ref: "@field",
        kind: "field",
        semantic: { role: "textbox", name: "Email" },
        state: { visible: true, enabled: true, focused: false },
        value: {
          kind: "text",
          display: options.fieldValue ?? "secret@example.test",
        },
        frameId: "web:0",
        capabilities: [{ kind: "setValue" }],
        provenance: { dom: true },
      },
      {
        ref: "@child",
        kind: "content",
        semantic: {
          role: "text",
          text: options.childText ?? "third-party secret",
        },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [],
        provenance: { dom: true },
      },
    ],
    forms: [{ ref: "@form", fieldRefs: ["@field"], actionRefs: ["@top"] }],
    capabilities: [{
      id: "page-cap",
      origin: "https://allowed.test",
      frameId: "web:0",
      name: "Dangerous page declaration",
      inputSchema: { arbitrary: "page-controlled" },
      trust: "page-declared",
    }],
    overlays: [{ kind: "menu", blocking: false }],
    dialogs: [{ title: "Dialog", modal: true }],
    delta: {
      baseRevision: "old",
      revision,
      changes: [],
    },
    warnings: ["internal runtime warning with sensitive detail"],
  };
}

function adapter(
  runtime: ModelBrowserRuntimeClient,
  tools = [
    "browser.open",
    "browser.observe",
    "browser.extract",
    "browser.verify",
    "browser.wait",
  ],
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    actBroker?: ModelActBroker;
  } = {},
): ModelFacingBrowserAdapter {
  return new ModelFacingBrowserAdapter(runtime, {
    tools: new ModelToolExposurePolicy(tools),
    origins: new ModelOriginAccessPolicy({
      readOrigins: ["https://allowed.test"],
      navigationOrigins: ["https://allowed.test"],
    }),
    ...options,
  });
}

describe("ModelFacingBrowserAdapter", () => {
  it("tool exposure 先于 runtime dispatch，内部控制面名称不可达", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      open: vi.fn(),
      observe: vi.fn(),
    };
    const service = adapter(runtime, ["browser.observe"]);

    await expect(service.invoke("browser.open", {
      url: "https://allowed.test/",
    })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    await expect(service.invoke("authorization.issue-strict-click", {}))
      .rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.observe).not.toHaveBeenCalled();
  });

  it("browser.open 使用独立 model navigation allowlist", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      open: vi.fn(async (input: BrowserOpenInput): Promise<BrowserOpenResult> => ({
        tabId: 8,
        requestedUrl: input.url,
        ownedBySession: true,
      })),
      observe: vi.fn(),
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.open", {
      url: "https://blocked.test/",
    })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    await expect(service.invoke("browser.open", {
      url: "https://user:pass@allowed.test/",
    })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    await expect(service.invoke("browser.open", {
      url: "https://allowed.test/start",
    })).resolves.toMatchObject({ tabId: 8 });
  });

  it("observation 出境时默认移除 values/page capabilities/delta，并过滤未授权 child frame", async () => {
    let received: BrowserObserveInput | undefined;
    const runtime: ModelBrowserRuntimeClient = {
      async open() {
        throw new Error("unused");
      },
      async observe(input) {
        received = input;
        return observation();
      },
    };
    const service = adapter(runtime);

    const result = await service.invoke("browser.observe", {
      tabId: 7,
      options: {
        includeValues: true,
      },
    }) as BrowserObservation;

    expect(received).toMatchObject({
      tabId: 7,
      options: {
        maxElements: 100,
        maxAxElements: 100,
        includeValues: false,
      },
    });
    expect(result.elements.map((element) => element.ref)).toEqual([
      "@top",
      "@field",
    ]);
    expect(result.elements.find((element) => element.ref === "@field")?.value)
      .toBeUndefined();
    expect(result.frames[1]).toMatchObject({
      frameId: "web:2",
      accessible: false,
      degradedReason: "model-egress-origin-blocked",
    });
    expect(result.frames[1]?.url).toBeUndefined();
    expect(result.frames[0]?.degradedReason).toBe("runtime-frame-degraded");
    expect(result.coverage.actionable.status).toBe("partial");
    expect(result.coverage.text.status).toBe("partial");
    expect(result.capabilities).toBeUndefined();
    expect(result.delta).toBeUndefined();
    expect(result.forms).toBeUndefined();
    expect(result.dialogs).toBeUndefined();
    expect(result.warnings).toEqual([
      "model-egress omitted runtime warnings",
      "model-egress omitted page-declared capabilities",
      "model-egress omitted runtime delta",
      "model-egress filtered non-allowlisted frame content",
    ]);
  });

  it("extract/verify 只能使用已成功出境的 revision，并在投影状态上本地执行", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation(); },
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-1",
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });

    await service.invoke("browser.observe", { tabId: 7 });

    const extracted = await service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-1",
    }) as { items: Array<{ ref: string }> };
    expect(extracted.items.map((item) => item.ref)).toEqual([
      "@top",
      "@field",
    ]);

    const hiddenText = await service.invoke("browser.verify", {
      tabId: 7,
      observedRevision: "rev-1",
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "third-party secret" }],
      },
    }) as VerificationResult;

    expect(hiddenText).toMatchObject({
      verified: false,
      conclusive: false,
    });
    expect(hiddenText.evidence[0]).not.toHaveProperty("observed");
  });

  it("默认 value redaction 阻止 field_value 通过 verify 旁路泄露", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation("rev-value", { fieldValue: "top-secret" }); },
    };
    const service = adapter(runtime);
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke("browser.verify", {
      tabId: 7,
      observedRevision: "rev-value",
      verification: {
        mode: "all",
        conditions: [{ type: "field_value", ref: "@field", equals: "top-secret" }],
      },
    }) as VerificationResult;

    expect(result.verified).toBe(false);
    expect(result.conclusive).toBe(false);
    expect(result.evidence[0]).not.toHaveProperty("observed");
  });

  it("sinceRevision 必须来自当前 model-visible ledger", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      observe: vi.fn(async () => observation()),
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      sinceRevision: "internal-rev",
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
    expect(runtime.observe).not.toHaveBeenCalled();
  });

  it("wait 只在 model-egress 投影后的 observation 上验证", async () => {
    let now = 0;
    let attempt = 0;
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() {
        attempt += 1;
        return observation(
          "rev-" + attempt,
          attempt >= 2 ? { topText: "Done" } : { childText: "Done" },
        );
      },
    };
    const service = adapter(runtime, undefined, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    const result = await service.invoke("browser.wait", {
      tabId: 7,
      timeoutMs: 200,
      pollIntervalMs: 50,
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "Done" }],
      },
    }) as BrowserWaitResult;

    expect(result).toMatchObject({
      timedOut: false,
      attempts: 2,
      verification: { verified: true },
      observation: { revision: { id: "rev-2" } },
    });
  });

  it("拒绝未知字段和超过 egress 上限的 model 输入", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation(); },
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      ownedBySession: true,
    })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      options: { maxElements: 101 },
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
  });
});

const ACT_TOOLS = [
  "browser.observe",
  "browser.extract",
  "browser.act",
];

const ACT_VERIFICATION = {
  mode: "all",
  conditions: [{ type: "text_present", text: "Saved" }],
} as const;

const EXECUTED: ModelActExecution = {
  status: "executed",
  effectClass: "unknown",
};

function actRequest(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@top",
    kind: "click",
    verification: ACT_VERIFICATION,
    ...patch,
  };
}

/**
 * 第一次 observe 返回 rev-1；之后（即 act 后）依次取 after 中的结果，用尽后重复最后一个。
 */
function sequencedRuntime(
  after: Array<() => BrowserObservation> = [() => observation("rev-2")],
): ModelBrowserRuntimeClient & {
  observe: ReturnType<typeof vi.fn>;
} {
  let calls = 0;
  return {
    async open() { throw new Error("unused"); },
    observe: vi.fn(async () => {
      calls += 1;
      if (calls === 1) return observation();
      const next = after[Math.min(calls - 2, after.length - 1)]!;
      return next();
    }),
  };
}

function fakeBroker(): ModelActBroker & {
  act: ReturnType<typeof vi.fn>;
} {
  return {
    act: vi.fn(async () => EXECUTED),
  };
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => { now += ms; }),
  };
}

function actAdapter(
  runtime: ModelBrowserRuntimeClient,
  actBroker: ModelActBroker | undefined,
  tools = ACT_TOOLS,
) {
  const clock = fakeClock();
  const service = adapter(runtime, tools, {
    ...clock,
    ...(actBroker !== undefined ? { actBroker } : {}),
  });
  return { service, clock };
}

function trustedRuntime(): TrustedActBrokerRuntimeClient & {
  act: ReturnType<typeof vi.fn>;
  issueStrictClick: ReturnType<typeof vi.fn>;
  requestOperatorApproval: ReturnType<typeof vi.fn>;
} {
  return {
    // 扩展在未投影的 fresh observation 上验证：隐藏 frame 中的文本让它返回 true。
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
          observed: "Saved in third-party secret frame",
        }],
      },
      verificationAttempts: 9,
    })),
    issueStrictClick: vi.fn(async (input: { authorizationId: string }) => ({
      id: input.authorizationId,
      expiresAt: 1,
    })),
    requestOperatorApproval: vi.fn(),
    operatorApprovalStatus: vi.fn(),
  };
}

function autoBroker(trusted: TrustedActBrokerRuntimeClient) {
  return createModelActBroker(trusted, {
    actOrigins: ["https://allowed.test"],
    budget: 4,
    approvalMode: "agent-owned-auto",
    approvalTimeoutMs: 1_000,
    uuid: () => "fixed-id",
  });
}

describe("ModelFacingBrowserAdapter browser.act", () => {
  it("未注入 act broker 时即使暴露 browser.act 也 POLICY_BLOCKED", async () => {
    const { service } = actAdapter(sequencedRuntime(), undefined);
    await service.invoke("browser.observe", { tabId: 7 });

    await expect(service.invoke("browser.act", actRequest()))
      .rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        message: "model act broker is not configured",
      });
  });

  it("未暴露 browser.act 时即使注入 broker 也 POLICY_BLOCKED", async () => {
    const broker = fakeBroker();
    const { service } = actAdapter(
      sequencedRuntime(),
      broker,
      ["browser.observe"],
    );
    await service.invoke("browser.observe", { tabId: 7 });

    await expect(service.invoke("browser.act", actRequest()))
      .rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(broker.act).not.toHaveBeenCalled();
  });

  it("模型传入 authorizationId / assurance 被拒，broker 不被调用", async () => {
    const broker = fakeBroker();
    const { service } = actAdapter(sequencedRuntime(), broker);
    await service.invoke("browser.observe", { tabId: 7 });

    for (const extra of [
      { authorizationId: "model-grant" },
      { assurance: "operator-approved" },
    ]) {
      await expect(service.invoke("browser.act", actRequest(extra)))
        .rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    }
    expect(broker.act).not.toHaveBeenCalled();
  });

  it("revision 未在本连接出境时 MODEL_EGRESS_BLOCKED", async () => {
    const broker = fakeBroker();
    const { service } = actAdapter(sequencedRuntime(), broker);

    await expect(service.invoke("browser.act", actRequest()))
      .rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
    expect(broker.act).not.toHaveBeenCalled();
  });

  it("被 egress 过滤掉的跨 origin child frame ref 与未投影 ref 均 REF_NOT_IN_OBSERVATION", async () => {
    const broker = fakeBroker();
    const { service } = actAdapter(sequencedRuntime(), broker);
    await service.invoke("browser.observe", { tabId: 7 });

    for (const ref of ["@child", "@unknown"]) {
      await expect(service.invoke("browser.act", actRequest({ ref })))
        .rejects.toMatchObject({ code: "REF_NOT_IN_OBSERVATION" });
    }
    expect(broker.act).not.toHaveBeenCalled();
  });

  it("broker 收到投影后的 observation（保留 tab.ownedBySession）；成功后在新投影 observation 上本地验证", async () => {
    const broker = fakeBroker();
    const runtime = sequencedRuntime([
      () => observation("rev-2"),
      () => observation("rev-3", { topText: "Saved" }),
    ]);
    const { service, clock } = actAdapter(runtime, broker);
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke(
      "browser.act",
      actRequest({ verifyTimeoutMs: 500 }),
    ) as ModelActResult;

    expect(broker.act).toHaveBeenCalledTimes(1);
    const [input, projected] = broker.act.mock.calls[0] as [
      unknown,
      BrowserObservation,
    ];
    expect(input).toEqual(actRequest({ verifyTimeoutMs: 500 }));
    expect(projected.tab.ownedBySession).toBe(true);
    expect(projected.elements.map((element) => element.ref)).toEqual([
      "@top",
      "@field",
    ]);
    expect(projected.capabilities).toBeUndefined();

    expect(result).toEqual({
      status: "executed",
      effectClass: "unknown",
      verification: {
        verified: true,
        conclusive: true,
        revision: "rev-3",
        evidence: [{
          condition: { type: "text_present", text: "Saved" },
          pass: true,
          conclusive: true,
        }],
      },
      verificationAttempts: 2,
    });
    // pollInterval 沿用 wait 默认 100ms。
    expect(clock.sleep).toHaveBeenCalledWith(100);
    // verification 中的 revision 已进入本连接出境 store，可继续 extract。
    await expect(service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-3",
    })).resolves.toMatchObject({ revision: "rev-3" });
  });

  it("未提供 verifyTimeoutMs 时本地验证窗口为默认 1500ms", async () => {
    const broker = fakeBroker();
    const { service, clock } = actAdapter(sequencedRuntime(), broker);
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke(
      "browser.act",
      actRequest(),
    ) as ModelActResult;

    expect(MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS).toBe(1_500);
    expect(clock.now()).toBe(MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS);
    expect(result.verification.verified).toBe(false);
    expect(result.verificationAttempts).toBe(16);
  });

  it("对抗：隐藏 frame 中有该文本 → 扩展说 true，投影后看不到 → 模型拿到 false 且无隐藏信息", async () => {
    const trusted = trustedRuntime();
    const runtime = sequencedRuntime([
      () => observation("rev-2", { childText: "Saved in third-party secret frame" }),
    ]);
    const { service } = actAdapter(runtime, autoBroker(trusted));
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke(
      "browser.act",
      actRequest({ verifyTimeoutMs: 5_000 }),
    ) as ModelActResult;

    expect(trusted.issueStrictClick).toHaveBeenCalledTimes(1);
    expect(trusted.requestOperatorApproval).not.toHaveBeenCalled();
    expect(trusted.act).toHaveBeenCalledWith(
      expect.objectContaining({ verifyTimeoutMs: 0 }),
    );
    expect(result.status).toBe("executed");
    expect(result.verification.verified).toBe(false);
    expect(result.verification.revision).toBe("rev-2");
    expect(result.verificationAttempts).not.toBe(9);
    const text = JSON.stringify(result);
    expect(text).not.toContain("third-party secret");
    expect(text).not.toContain("fresh-unexposed-rev");
    expect(text).not.toContain("observed");
  });

  it("act 后跳转到非 read origin：返回 executed + inconclusive，不含 URL 或原始错误", async () => {
    const trusted = trustedRuntime();
    const offOrigin = (): BrowserObservation => {
      const base = observation("rev-secret");
      return {
        ...base,
        tab: {
          ...base.tab,
          url: "https://blocked.test/account?token=leak",
          origin: "https://blocked.test",
        },
      };
    };
    const runtime = sequencedRuntime([offOrigin]);
    const { service } = actAdapter(runtime, autoBroker(trusted));
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke(
      "browser.act",
      actRequest({ verifyTimeoutMs: 300 }),
    ) as ModelActResult;

    expect(result).toEqual({
      status: "executed",
      effectClass: "unknown",
      verification: {
        verified: false,
        conclusive: false,
        evidence: [{
          condition: { type: "text_present", text: "Saved" },
          pass: false,
          conclusive: false,
          reason: "model-facing observation unavailable after browser.act",
        }],
      },
      verificationAttempts: 4,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("blocked.test");
    expect(text).not.toContain("token");
    expect(text).not.toContain("rev-secret");
    expect(text).not.toContain("allowlisted");
    // 非 read origin 的 revision 不进入出境 store。
    await expect(service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-secret",
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
  });

  it("act 后 observe 抛出带敏感文本的普通异常时同样 inconclusive，不透传原文", async () => {
    const broker = fakeBroker();
    const runtime = sequencedRuntime([() => {
      throw new Error("internal https://hidden.test/path failure");
    }]);
    const { service } = actAdapter(runtime, broker);
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke(
      "browser.act",
      actRequest({ verifyTimeoutMs: 0 }),
    ) as ModelActResult;

    expect(result.status).toBe("executed");
    expect(result.verification.conclusive).toBe(false);
    expect(result.verificationAttempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain("hidden.test");
  });

  it("broker 失败（未执行）时 act 直接报错，不进入本地验证", async () => {
    const broker = fakeBroker();
    broker.act.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "AUTHORIZATION_REQUIRED" }),
    );
    const runtime = sequencedRuntime();
    const { service } = actAdapter(runtime, broker);
    await service.invoke("browser.observe", { tabId: 7 });

    await expect(service.invoke("browser.act", actRequest()))
      .rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect(runtime.observe).toHaveBeenCalledTimes(1);
  });
});
