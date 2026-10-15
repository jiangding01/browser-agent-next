import { describe, expect, it, vi } from "vitest";
import {
  BrowserRuntimeError,
  type BrowserObservation,
  type VerificationResult,
} from "@browser-agent-next/core";
import {
  MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
  MODEL_ACT_GRANT_TTL_MS,
  createModelActBroker,
  type ModelActBrokerOptions,
} from "./modelActBroker.js";
import type { ModelActInput } from "./modelToolInput.js";
import type {
  TrustedActBrokerRuntimeClient,
  TrustedActResult,
  TrustedOperatorApprovalState,
} from "./trustedRuntimeClient.js";

function observation(
  options: {
    tabId?: number;
    revision?: string;
    origin?: string;
    ownedBySession?: boolean;
  } = {},
): BrowserObservation {
  const origin = options.origin ?? "https://act.test";
  return {
    schemaVersion: 1,
    tab: {
      tabId: options.tabId ?? 7,
      title: "Fixture",
      url: origin + "/page",
      origin,
      ownedBySession: options.ownedBySession ?? true,
    },
    revision: {
      id: options.revision ?? "rev-1",
      stateEpoch: "runtime",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 3, totalKnown: 3 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "complete", returned: 3, totalKnown: 3 },
      frames: { discovered: 3, accessible: 3, degraded: [] },
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
        url: origin + "/page",
        documentEpoch: "doc-1",
        accessible: true,
      },
      {
        frameId: "web:1",
        parentFrameId: "web:0",
        url: "about:blank",
        documentEpoch: "doc-blank",
        accessible: true,
      },
      {
        frameId: "web:2",
        parentFrameId: "web:0",
        url: "https://read-only.test/embed",
        documentEpoch: "doc-child",
        accessible: true,
      },
    ],
    elements: ["@a", "@b", "@c", "@d"].map((ref) => ({
      ref,
      kind: "element" as const,
      semantic: { role: "button", name: ref },
      state: { visible: true, enabled: true, focused: false },
      frameId: ref === "@d" ? "web:1" : "web:0",
      capabilities: [{ kind: "click" as const }],
      provenance: { dom: true },
    })).concat([{
      ref: "@readonly",
      kind: "element" as const,
      semantic: { role: "button", name: "embedded" },
      state: { visible: true, enabled: true, focused: false },
      frameId: "web:2",
      capabilities: [{ kind: "click" as const }],
      provenance: { dom: true },
    }]),
  };
}

function actInput(
  ref = "@a",
  patch: Partial<ModelActInput> = {},
): ModelActInput {
  return {
    tabId: 7,
    observedRevision: "rev-1",
    ref,
    kind: "click",
    verification: {
      mode: "all",
      conditions: [{ type: "text_present", text: "Saved" }],
    },
    ...patch,
  };
}

const RAW_VERIFICATION: VerificationResult = {
  verified: true,
  conclusive: true,
  revision: "fresh-unexposed-rev",
  evidence: [{
    condition: { type: "text_present", text: "Saved" },
    pass: true,
    conclusive: true,
    observed: "hidden third-party text",
  }],
};

interface FakeRuntime extends TrustedActBrokerRuntimeClient {
  act: ReturnType<typeof vi.fn>;
  issueStrictClick: ReturnType<typeof vi.fn>;
  requestOperatorApproval: ReturnType<typeof vi.fn>;
  operatorApprovalStatus: ReturnType<typeof vi.fn>;
}

function fakeRuntime(
  states: TrustedOperatorApprovalState[] = ["approved"],
): FakeRuntime {
  const queue = [...states];
  return {
    act: vi.fn(async (): Promise<TrustedActResult> => ({
      status: "executed",
      verification: RAW_VERIFICATION,
      verificationAttempts: 2,
      // trusted client 已丢弃这些字段；这里刻意模拟异形透传，证明 broker 也不出境。
      freshRevision: "fresh-unexposed-rev",
      postActionObservationError: "raw error text",
    } as TrustedActResult)),
    issueStrictClick: vi.fn(async (input: { authorizationId: string }) => ({
      id: input.authorizationId,
      expiresAt: 999_999,
    })),
    requestOperatorApproval: vi.fn(async () => ({
      approvalRequestId: "approval-1",
      expiresAt: 999_999,
    })),
    operatorApprovalStatus: vi.fn(async () => ({
      state: queue.length > 1 ? queue.shift()! : queue[0]!,
    })),
  };
}

function broker(
  runtime: TrustedActBrokerRuntimeClient,
  options: Partial<ModelActBrokerOptions> = {},
) {
  let now = 0;
  let id = 0;
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const instance = createModelActBroker(runtime, {
    actOrigins: ["https://act.test", "https://other-act.test"],
    budget: 16,
    approvalMode: "operator",
    approvalTimeoutMs: 60_000,
    now: () => now,
    sleep,
    uuid: () => "uuid-" + ++id,
    ...options,
  });
  return { instance, sleep };
}

describe("createModelActBroker", () => {
  it("agent-owned-auto + owned tab 走 control-plane grant，id 全部来自注入 uuid", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await instance.act(actInput(), observation());

    expect(runtime.issueStrictClick).toHaveBeenCalledWith({
      authorizationId: "uuid-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@a",
      ttlMs: MODEL_ACT_GRANT_TTL_MS,
    });
    expect(runtime.requestOperatorApproval).not.toHaveBeenCalled();
    expect(runtime.act).toHaveBeenCalledWith({
      tabId: 7,
      actionId: "uuid-2",
      observedRevision: "rev-1",
      ref: "@a",
      authorizationId: "uuid-1",
      verification: actInput().verification,
      verifyTimeoutMs: 0,
    });
  });

  it("调用 runtime.act 时 verifyTimeoutMs 恒为 0，即使模型传了 5000", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime);

    await instance.act(
      actInput("@a", { verifyTimeoutMs: 5_000 }),
      observation(),
    );
    await instance.act(actInput("@b"), observation());

    expect(
      runtime.act.mock.calls.map(
        ([input]) => (input as { verifyTimeoutMs?: number })
          .verifyTimeoutMs,
      ),
    ).toEqual([0, 0]);
  });

  it("扩展返回的 verification/attempts 整体丢弃：结果只含 status/effectClass，无 freshRevision、postActionObservationError、observed", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime);

    const result = await instance.act(actInput(), observation());

    expect(result).toEqual({
      status: "executed",
      effectClass: "unknown",
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("verification");
    expect(text).not.toContain("Saved");
    expect(text).not.toContain("freshRevision");
    expect(text).not.toContain("fresh-unexposed-rev");
    expect(text).not.toContain("postActionObservationError");
    expect(text).not.toContain("observed");
    expect(text).not.toContain("hidden third-party text");
  });

  it("operator 路径：pending 轮询（间隔 1s）直到 approved 再执行", async () => {
    const runtime = fakeRuntime(["pending", "pending", "approved"]);
    const { instance, sleep } = broker(runtime);

    await instance.act(actInput(), observation());

    expect(runtime.requestOperatorApproval).toHaveBeenCalledWith({
      authorizationId: "uuid-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@a",
      ttlMs: MODEL_ACT_GRANT_TTL_MS,
    });
    expect(runtime.operatorApprovalStatus).toHaveBeenCalledTimes(3);
    expect(runtime.operatorApprovalStatus).toHaveBeenCalledWith(
      "approval-1",
    );
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
      MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
      MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
    ]);
    expect(runtime.issueStrictClick).not.toHaveBeenCalled();
    expect(runtime.act).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId: "uuid-1" }),
    );
  });

  it("默认 operator 模式下，即使 tab 是 ownedBySession 也走 operator", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime);

    await instance.act(
      actInput(),
      observation({ ownedBySession: true }),
    );

    expect(runtime.issueStrictClick).not.toHaveBeenCalled();
    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
  });

  it("agent-owned-auto 下非 owned tab 强制走 operator", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await instance.act(
      actInput(),
      observation({ ownedBySession: false }),
    );

    expect(runtime.issueStrictClick).not.toHaveBeenCalled();
    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
  });

  it("tab origin 或目标 frame origin 不在 act allowlist 时 ORIGIN_NOT_ALLOWED，且不消耗预算", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime, { budget: 1 });

    await expect(instance.act(
      actInput(),
      observation({ origin: "https://read-only.test" }),
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    await expect(instance.act(
      actInput("@readonly"),
      observation(),
    )).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    expect(runtime.requestOperatorApproval).not.toHaveBeenCalled();
    expect(runtime.act).not.toHaveBeenCalled();

    // about:blank child frame 继承父 frame origin。
    await expect(instance.act(
      actInput("@d"),
      observation(),
    )).resolves.toMatchObject({ status: "executed" });
  });

  it("observation 与入参不一致或 ref 不在 observation 中时拒绝", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime);

    await expect(instance.act(
      actInput("@a", { observedRevision: "rev-2" }),
      observation(),
    )).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(instance.act(
      actInput("@a", { tabId: 8 }),
      observation(),
    )).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(instance.act(
      actInput("@missing"),
      observation(),
    )).rejects.toMatchObject({ code: "REF_NOT_IN_OBSERVATION" });
    expect(runtime.requestOperatorApproval).not.toHaveBeenCalled();
  });

  it("预算耗尽后 POLICY_BLOCKED", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime, { budget: 2 });

    await instance.act(actInput("@a"), observation());
    await instance.act(actInput("@b"), observation());

    await expect(instance.act(actInput("@c"), observation()))
      .rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        message: expect.stringContaining("budget"),
      });
    expect(runtime.act).toHaveBeenCalledTimes(2);
  });

  it("同一 (tab, revision, ref) 第二次被拒；首次失败后仍被拒", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime);

    await instance.act(actInput("@a"), observation());
    await expect(instance.act(actInput("@a"), observation()))
      .rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        message: expect.stringContaining("already attempted"),
      });

    runtime.act.mockRejectedValueOnce(
      new BrowserRuntimeError("TARGET_GONE", "gone"),
    );
    await expect(instance.act(actInput("@b"), observation()))
      .rejects.toMatchObject({ code: "TARGET_GONE" });
    await expect(instance.act(actInput("@b"), observation()))
      .rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        message: expect.stringContaining("already attempted"),
      });

    expect(runtime.act).toHaveBeenCalledTimes(2);

    // 不同 revision 是不同的 key。
    await expect(instance.act(
      actInput("@b", { observedRevision: "rev-2" }),
      observation({ revision: "rev-2" }),
    )).resolves.toMatchObject({ status: "executed" });
  });

  it("issueStrictClick 失败不回滚已落账的 (tab, revision, ref)", async () => {
    const runtime = fakeRuntime();
    runtime.issueStrictClick.mockRejectedValueOnce(
      new BrowserRuntimeError("AUTHORIZATION_REQUIRED", "denied"),
    );
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await expect(instance.act(actInput(), observation()))
      .rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(instance.act(actInput(), observation()))
      .rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected", "rejected"],
    ["expired", "expired"],
    ["invalidated", "invalidated"],
    ["unknown", "unknown"],
  ] as const)(
    "operator 状态 %s → AUTHORIZATION_REQUIRED 且不执行",
    async (state, fragment) => {
      const runtime = fakeRuntime(["pending", state]);
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation()))
        .rejects.toMatchObject({
          code: "AUTHORIZATION_REQUIRED",
          message: expect.stringContaining(fragment),
        });
      expect(runtime.act).not.toHaveBeenCalled();
    },
  );

  it("operator approval 超过 approvalTimeoutMs 后 AUTHORIZATION_REQUIRED", async () => {
    const runtime = fakeRuntime(["pending"]);
    const { instance, sleep } = broker(runtime, {
      approvalTimeoutMs: 2_500,
    });

    await expect(instance.act(actInput(), observation()))
      .rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
        message: "operator approval timed out",
      });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      1_000,
      1_000,
      500,
    ]);
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it("act 抛 ACTION_OUTCOME_UNKNOWN 后该 tab 降级，同 tab 后续走 operator，其他 tab 不受影响", async () => {
    const runtime = fakeRuntime();
    runtime.act.mockRejectedValueOnce(
      new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "lost"),
    );
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await expect(instance.act(actInput("@a"), observation()))
      .rejects.toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN" });
    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);

    await instance.act(actInput("@b"), observation());
    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);

    await instance.act(
      actInput("@a", { tabId: 9 }),
      observation({ tabId: 9 }),
    );
    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(2);
  });

  it("降级不可逆：后续 operator 成功也不会恢复 control-plane 路径", async () => {
    const runtime = fakeRuntime();
    runtime.act.mockRejectedValueOnce(
      new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "lost"),
    );
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await expect(instance.act(actInput("@a"), observation()))
      .rejects.toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN" });
    await instance.act(actInput("@b"), observation());
    await instance.act(actInput("@c"), observation());
    await instance.act(
      actInput("@a", { observedRevision: "rev-2" }),
      observation({ revision: "rev-2" }),
    );

    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(3);
  });

  it("授权阶段出现 ACTION_OUTCOME_UNKNOWN 同样降级", async () => {
    const runtime = fakeRuntime();
    runtime.issueStrictClick.mockRejectedValueOnce(
      new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "maybe issued"),
    );
    const { instance } = broker(runtime, {
      approvalMode: "agent-owned-auto",
    });

    await expect(instance.act(actInput("@a"), observation()))
      .rejects.toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN" });
    await instance.act(actInput("@b"), observation());

    expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
  });

  it("trusted Runtime 错误只保留 code，扩展原始 message 不出境", async () => {
    const runtime = fakeRuntime();
    runtime.act.mockRejectedValueOnce(
      new BrowserRuntimeError(
        "TARGET_GONE",
        "frame https://hidden.test/secret detached",
      ),
    );
    runtime.requestOperatorApproval.mockRejectedValueOnce(
      new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "revision drifted because https://hidden.test changed",
      ),
    );
    const { instance } = broker(runtime);

    const authorizationError = await instance
      .act(actInput("@a"), observation())
      .catch((error: unknown) => error);
    expect(authorizationError).toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    });
    expect((authorizationError as Error).message)
      .not.toContain("hidden.test");

    const executionError = await instance
      .act(actInput("@b"), observation())
      .catch((error: unknown) => error);
    expect(executionError).toMatchObject({ code: "TARGET_GONE" });
    expect((executionError as Error).message).not.toContain("hidden.test");
  });

  it("构造时校验 approvalTimeoutMs、budget、approvalMode 与 act origins", () => {
    const runtime = fakeRuntime();
    const base: ModelActBrokerOptions = {
      actOrigins: ["https://act.test"],
      budget: 1,
      approvalMode: "operator",
      approvalTimeoutMs: 1,
    };

    expect(() => createModelActBroker(runtime, base)).not.toThrow();
    expect(() => createModelActBroker(runtime, {
      ...base,
      approvalTimeoutMs: 120_000,
    })).not.toThrow();
    for (const patch of [
      { approvalTimeoutMs: 0 },
      { approvalTimeoutMs: 120_001 },
      { approvalTimeoutMs: 1.5 },
      { budget: 0 },
      { budget: 257 },
      { approvalMode: "auto" as ModelActBrokerOptions["approvalMode"] },
      { actOrigins: ["https://act.test/path"] },
      { actOrigins: ["*.act.test"] },
    ]) {
      expect(() =>
        createModelActBroker(runtime, { ...base, ...patch })
      ).toThrow();
    }
  });
});
