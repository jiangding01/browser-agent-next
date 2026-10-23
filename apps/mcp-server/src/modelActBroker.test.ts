import { describe, expect, it, vi } from "vitest";
import {
  BrowserRuntimeError,
  type BrowserObservation,
  type VerificationResult,
} from "@browser-agent-next/core";
import {
  MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
  MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
  MODEL_ACT_GRANT_TTL_MS,
  createModelActBroker,
  type ModelActBrokerOptions,
  type ModelActProgress,
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
  cancelStrictClick: ReturnType<typeof vi.fn>;
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
    cancelStrictClick: vi.fn(async () => {}),
  };
}

function broker(
  runtime: TrustedActBrokerRuntimeClient,
  options: Partial<ModelActBrokerOptions> = {},
  hooks: {
    /** 第 call 次（从 1 开始）sleep 推进时间之后调用，可在此 abort。 */
    onSleep?: (call: number) => void;
  } = {},
) {
  let now = 0;
  let id = 0;
  let sleepCalls = 0;
  // 与默认 sleep 一致：signal 已 abort 时立即返回，不推进时间。
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    now += ms;
    sleepCalls += 1;
    hooks.onSleep?.(sleepCalls);
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

    // 第二参数为 approvalTimeoutMs（broker 默认 60s）。
    expect(runtime.requestOperatorApproval).toHaveBeenCalledWith({
      authorizationId: "uuid-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@a",
      ttlMs: MODEL_ACT_GRANT_TTL_MS,
    }, 60_000);
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
    ["cancelled", "cancelled"],
    ["unknown", "unknown"],
  ] as const)(
    "operator 状态 %s → AUTHORIZATION_REQUIRED 且不执行，并撤销一次授权",
    async (state, fragment) => {
      const runtime = fakeRuntime(["pending", state]);
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation()))
        .rejects.toMatchObject({
          code: "AUTHORIZATION_REQUIRED",
          message: expect.stringContaining(fragment),
        });
      expect(runtime.act).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CLIENT_CANCELLED = {
  code: "AUTHORIZATION_REQUIRED",
  message: "browser.act was cancelled by the client",
};

describe("createModelActBroker 取消、撤销与 progress", () => {
  it("a. 入口 signal 已 abort：零 RPC、不扣预算、不落账，之后同一 ref 仍可 act", async () => {
    const runtime = fakeRuntime();
    const { instance, sleep } = broker(runtime, { budget: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(instance.act(actInput(), observation(), {
      signal: controller.signal,
    })).rejects.toMatchObject(CLIENT_CANCELLED);

    expect(runtime.issueStrictClick).not.toHaveBeenCalled();
    expect(runtime.requestOperatorApproval).not.toHaveBeenCalled();
    expect(runtime.operatorApprovalStatus).not.toHaveBeenCalled();
    expect(runtime.act).not.toHaveBeenCalled();
    expect(runtime.cancelStrictClick).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();

    // budget=1 未被消耗，同一 (tab, revision, ref) 也未落账。
    await expect(instance.act(actInput(), observation()))
      .resolves.toEqual({ status: "executed", effectClass: "unknown" });
    // 被取消的那次没有消耗 uuid。
    expect(runtime.requestOperatorApproval).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId: "uuid-1" }),
      60_000,
    );
  });

  it("b. operator 路径 requestOperatorApproval 第二参数为 approvalTimeoutMs", async () => {
    const runtime = fakeRuntime();
    const { instance } = broker(runtime, { approvalTimeoutMs: 2_500 });

    await instance.act(actInput(), observation());

    expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
    expect(runtime.requestOperatorApproval.mock.calls[0]![1]).toBe(2_500);
  });

  it("sleep 收到 tool call 的 signal", async () => {
    const runtime = fakeRuntime(["pending", "approved"]);
    const { instance, sleep } = broker(runtime);
    const controller = new AbortController();

    await instance.act(actInput(), observation(), {
      signal: controller.signal,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    for (const call of sleep.mock.calls) {
      expect(call[1]).toBe(controller.signal);
    }
  });

  describe("c. grant id 生成后未成功返回时恰好撤销一次", () => {
    it("成功（operator 与 agent-owned-auto）不撤销", async () => {
      const runtime = fakeRuntime();
      const { instance } = broker(runtime);
      await instance.act(actInput("@a"), observation());

      const autoRuntime = fakeRuntime();
      const auto = broker(autoRuntime, {
        approvalMode: "agent-owned-auto",
      });
      await auto.instance.act(actInput("@a"), observation());

      expect(runtime.cancelStrictClick).not.toHaveBeenCalled();
      expect(autoRuntime.cancelStrictClick).not.toHaveBeenCalled();
    });

    it("grant id 生成前的拒绝（origin / ref / 预算 / 重复 key）不撤销", async () => {
      const runtime = fakeRuntime();
      const { instance } = broker(runtime, { budget: 2 });

      await instance.act(actInput("@a"), observation());
      await expect(instance.act(actInput("@a"), observation()))
        .rejects.toMatchObject({ code: "POLICY_BLOCKED" });
      await expect(instance.act(actInput("@missing"), observation()))
        .rejects.toMatchObject({ code: "REF_NOT_IN_OBSERVATION" });
      await expect(instance.act(actInput("@readonly"), observation()))
        .rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      // 重复 key 那次已扣预算，此处预算耗尽。
      await expect(instance.act(actInput("@c"), observation()))
        .rejects.toMatchObject({
          code: "POLICY_BLOCKED",
          message: expect.stringContaining("budget"),
        });

      expect(runtime.cancelStrictClick).not.toHaveBeenCalled();
    });

    it("approval 超时：撤销一次，不降级", async () => {
      const runtime = fakeRuntime(["pending"]);
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
        approvalTimeoutMs: 2_500,
      });

      // 非 owned tab 强制走 operator，用于观察超时后是否降级。
      await expect(instance.act(
        actInput("@a"),
        observation({ ownedBySession: false }),
      )).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
        message: "operator approval timed out",
      });
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");

      // 同 tab 改为 owned 后仍走 control-plane：超时不降级。
      await instance.act(actInput("@b"), observation());
      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
    });

    it("轮询 sleep 期间 abort：抛 client cancelled，撤销一次，不再查询状态，不降级", async () => {
      const runtime = fakeRuntime(["pending"]);
      const controller = new AbortController();
      const onProgress = vi.fn();
      const { instance } = broker(
        runtime,
        { approvalMode: "agent-owned-auto" },
        {
          onSleep: (call) => {
            if (call === 2) controller.abort();
          },
        },
      );

      await expect(instance.act(
        actInput("@a"),
        observation({ ownedBySession: false }),
        { signal: controller.signal, onProgress },
      )).rejects.toMatchObject(CLIENT_CANCELLED);

      expect(runtime.operatorApprovalStatus).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(runtime.act).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");

      await instance.act(actInput("@b"), observation());
      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
    });

    it("status RPC 期间 abort：status 返回后立即抛 client cancelled、不上报 progress 并撤销一次", async () => {
      const runtime = fakeRuntime(["pending"]);
      const controller = new AbortController();
      runtime.operatorApprovalStatus.mockImplementationOnce(async () => {
        controller.abort();
        return { state: "pending" };
      });
      const { instance, sleep } = broker(runtime);
      const onProgress = vi.fn();

      await expect(instance.act(actInput(), observation(), {
        signal: controller.signal,
        onProgress,
      })).rejects.toMatchObject(CLIENT_CANCELLED);

      expect(sleep).toHaveBeenCalledTimes(1);
      expect(runtime.operatorApprovalStatus).toHaveBeenCalledTimes(1);
      expect(onProgress).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
    });

    it("status RPC 期间 abort 且结果为 approved：不执行 act 并撤销一次", async () => {
      const runtime = fakeRuntime(["approved"]);
      const controller = new AbortController();
      runtime.operatorApprovalStatus.mockImplementationOnce(async () => {
        controller.abort();
        return { state: "approved" };
      });
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation(), {
        signal: controller.signal,
      })).rejects.toMatchObject(CLIENT_CANCELLED);

      expect(runtime.act).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
    });

    it("默认 sleep 在 abort 时立即返回（真实计时器）", async () => {
      const runtime = fakeRuntime(["pending"]);
      const instance = createModelActBroker(runtime, {
        actOrigins: ["https://act.test"],
        budget: 1,
        approvalMode: "operator",
        approvalTimeoutMs: 120_000,
        uuid: () => "real-sleep-id",
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();

      await expect(instance.act(actInput(), observation(), {
        signal: controller.signal,
      })).rejects.toMatchObject(CLIENT_CANCELLED);

      // 远小于 1s 轮询间隔：sleep 被 signal 提前唤醒。
      expect(Date.now() - started).toBeLessThan(900);
      expect(runtime.operatorApprovalStatus).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("real-sleep-id");
    });

    it("status 抛错：撤销一次，原错误码不变", async () => {
      const runtime = fakeRuntime();
      runtime.operatorApprovalStatus.mockRejectedValueOnce(
        new BrowserRuntimeError(
          "AUTHORIZATION_REQUIRED",
          "status failed for https://hidden.test",
        ),
      );
      const { instance } = broker(runtime);

      const error = await instance.act(actInput(), observation())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
      expect((error as Error).message).not.toContain("hidden.test");
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
    });

    it("requestOperatorApproval 抛错：撤销一次", async () => {
      const runtime = fakeRuntime();
      runtime.requestOperatorApproval.mockRejectedValueOnce(
        new BrowserRuntimeError("AUTHORIZATION_REQUIRED", "denied"),
      );
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation()))
        .rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
      expect(runtime.operatorApprovalStatus).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
    });

    it("issueStrictClick 抛错：撤销一次", async () => {
      const runtime = fakeRuntime();
      runtime.issueStrictClick.mockRejectedValueOnce(
        new BrowserRuntimeError("AUTHORIZATION_REQUIRED", "denied"),
      );
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      await expect(instance.act(actInput(), observation()))
        .rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
    });

    it.each([
      "TARGET_GONE",
      "ACTION_OUTCOME_UNKNOWN",
    ] as const)(
      "执行失败（%s）：撤销一次，错误码不变",
      async (code) => {
        const runtime = fakeRuntime();
        runtime.act.mockRejectedValueOnce(
          new BrowserRuntimeError(code, "raw https://hidden.test"),
        );
        const { instance } = broker(runtime);

        const error = await instance.act(actInput(), observation())
          .catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code });
        expect((error as Error).message).not.toContain("hidden.test");
        expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
        expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
      },
    );

    it("执行抛非 BrowserRuntimeError：撤销一次且仍降级", async () => {
      const runtime = fakeRuntime();
      const raw = new Error("socket hang up");
      runtime.act.mockRejectedValueOnce(raw);
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      // 非 BrowserRuntimeError 原样抛出（由 MCP bridge 归一为 INTERNAL_ERROR）。
      await expect(instance.act(actInput("@a"), observation()))
        .rejects.toBe(raw);
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);

      await instance.act(actInput("@b"), observation());
      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["status 抛错", "status"],
      ["执行失败 TARGET_GONE", "act"],
      ["执行失败 ACTION_OUTCOME_UNKNOWN", "act-unknown"],
      ["超时", "timeout"],
      ["client cancelled", "abort"],
    ] as const)(
      "cancelStrictClick 自身抛错不覆盖原错误（%s）",
      async (_name, scenario) => {
        async function run(cancelFails: boolean) {
          const runtime = fakeRuntime(
            scenario === "timeout" ? ["pending"] : ["approved"],
          );
          if (cancelFails) {
            runtime.cancelStrictClick.mockRejectedValue(
              new BrowserRuntimeError(
                "REF_STALE",
                "cancel failed https://cancel-secret.test",
              ),
            );
          }
          if (scenario === "status") {
            runtime.operatorApprovalStatus.mockRejectedValueOnce(
              new BrowserRuntimeError("STATE_INCOMPLETE", "hidden"),
            );
          }
          if (scenario === "act") {
            runtime.act.mockRejectedValueOnce(
              new BrowserRuntimeError("TARGET_GONE", "hidden"),
            );
          }
          if (scenario === "act-unknown") {
            runtime.act.mockRejectedValueOnce(
              new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "hidden"),
            );
          }
          const controller = new AbortController();
          const { instance } = broker(
            runtime,
            { approvalTimeoutMs: 1_500 },
            {
              onSleep: () => {
                if (scenario === "abort") controller.abort();
              },
            },
          );
          const error = await instance
            .act(actInput(), observation(), {
              signal: controller.signal,
            })
            .catch((caught: unknown) => caught);
          expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
          return error as BrowserRuntimeError;
        }

        const baseline = await run(false);
        const withFailingCancel = await run(true);

        expect(withFailingCancel).toBeInstanceOf(BrowserRuntimeError);
        expect(withFailingCancel.code).toBe(baseline.code);
        expect(withFailingCancel.message).toBe(baseline.message);
        expect(withFailingCancel.message).not.toContain("cancel-secret");
        expect(withFailingCancel.code).not.toBe("REF_STALE");
      },
    );

    it("ACTION_OUTCOME_UNKNOWN 失败且 cancel 抛错时仍降级", async () => {
      const runtime = fakeRuntime();
      runtime.act.mockRejectedValueOnce(
        new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "lost"),
      );
      runtime.cancelStrictClick.mockRejectedValue(new Error("cancel down"));
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      await expect(instance.act(actInput("@a"), observation()))
        .rejects.toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN" });
      await instance.act(actInput("@b"), observation());

      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
    });

    it("降级先于撤销落定：cancelStrictClick 挂起期间同 tab 第二次 act 已走 operator approval", async () => {
      const runtime = fakeRuntime();
      runtime.act.mockRejectedValueOnce(
        new BrowserRuntimeError("ACTION_OUTCOME_UNKNOWN", "lost"),
      );
      const pendingCancel = deferred<void>();
      runtime.cancelStrictClick.mockImplementationOnce(
        () => pendingCancel.promise,
      );
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      const first = instance.act(actInput("@a"), observation());
      const firstSettled = first.catch((caught: unknown) => caught);
      await vi.waitFor(() => {
        expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      });

      // 撤销 RPC 仍未完成，第一次 act 尚未返回。
      await expect(instance.act(actInput("@b"), observation()))
        .resolves.toEqual({ status: "executed", effectClass: "unknown" });
      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.requestOperatorApproval).toHaveBeenCalledTimes(1);
      expect(runtime.requestOperatorApproval).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "@b", tabId: 7 }),
        60_000,
      );

      pendingCancel.resolve();
      await expect(firstSettled).resolves.toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
      });
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
    });
  });

  describe("d. 授权完成后、act 之前已 abort", () => {
    it("operator approved 后已 abort：不调用 runtime.act，撤销一次，抛 client cancelled", async () => {
      const runtime = fakeRuntime();
      const controller = new AbortController();
      runtime.operatorApprovalStatus.mockImplementationOnce(async () => {
        controller.abort();
        return { state: "approved" };
      });
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation(), {
        signal: controller.signal,
      })).rejects.toMatchObject(CLIENT_CANCELLED);

      expect(runtime.act).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");
    });

    it("agent-owned-auto issue 后已 abort：不调用 runtime.act，撤销一次，不降级", async () => {
      const runtime = fakeRuntime();
      const controller = new AbortController();
      runtime.issueStrictClick.mockImplementationOnce(
        async (input: { authorizationId: string }) => {
          controller.abort();
          return { id: input.authorizationId, expiresAt: 999_999 };
        },
      );
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      await expect(instance.act(actInput("@a"), observation(), {
        signal: controller.signal,
      })).rejects.toMatchObject(CLIENT_CANCELLED);

      expect(runtime.act).not.toHaveBeenCalled();
      expect(runtime.cancelStrictClick).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).toHaveBeenCalledWith("uuid-1");

      // 客户端取消不降级。
      await instance.act(actInput("@b"), observation());
      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(2);
      expect(runtime.requestOperatorApproval).not.toHaveBeenCalled();
    });
  });

  it.each([
    "operator",
    "agent-owned-auto",
  ] as const)(
    "e. 在途 act 期间 abort 不影响结果（%s）：返回 executed 且不撤销",
    async (approvalMode) => {
      const runtime = fakeRuntime();
      const pendingAct = deferred<TrustedActResult>();
      runtime.act.mockImplementationOnce(() => pendingAct.promise);
      const controller = new AbortController();
      const { instance } = broker(runtime, { approvalMode });

      const result = instance.act(actInput(), observation(), {
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(runtime.act).toHaveBeenCalledTimes(1);
      });
      controller.abort();
      pendingAct.resolve({
        status: "executed",
        verification: RAW_VERIFICATION,
        verificationAttempts: 1,
      });

      await expect(result).resolves.toEqual({
        status: "executed",
        effectClass: "unknown",
      });
      expect(runtime.cancelStrictClick).not.toHaveBeenCalled();
      // act RPC 本身不携带 signal。
      expect(runtime.act.mock.calls[0]).toHaveLength(1);
    },
  );

  describe("f. operator 等待期间的 progress", () => {
    it("每次 pending 后报告递增 progress，只含 progress 与固定 message", async () => {
      const runtime = fakeRuntime([
        "pending",
        "pending",
        "pending",
        "approved",
      ]);
      const progress: ModelActProgress[] = [];
      const { instance } = broker(runtime);

      await instance.act(actInput(), observation(), {
        onProgress: (item) => progress.push(item),
      });

      expect(progress).toEqual([
        { progress: 1, message: MODEL_ACT_APPROVAL_PROGRESS_MESSAGE },
        { progress: 2, message: MODEL_ACT_APPROVAL_PROGRESS_MESSAGE },
        { progress: 3, message: MODEL_ACT_APPROVAL_PROGRESS_MESSAGE },
      ]);
      for (const item of progress) {
        expect(Object.keys(item).sort()).toEqual(["message", "progress"]);
      }
      const text = JSON.stringify(progress);
      for (const secret of [
        "approval-1",
        "uuid-",
        "@a",
        "act.test",
        "rev-1",
        "Fixture",
        "total",
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it("首轮即 approved 时不报告 progress", async () => {
      const runtime = fakeRuntime(["approved"]);
      const onProgress = vi.fn();
      const { instance } = broker(runtime);

      await instance.act(actInput(), observation(), { onProgress });

      expect(onProgress).not.toHaveBeenCalled();
    });

    it("onProgress 抛错被吞，审批与执行照常完成", async () => {
      const runtime = fakeRuntime(["pending", "pending", "approved"]);
      const onProgress = vi.fn(() => {
        throw new Error("client gone");
      });
      const { instance } = broker(runtime);

      await expect(instance.act(actInput(), observation(), {
        onProgress,
      })).resolves.toEqual({ status: "executed", effectClass: "unknown" });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(runtime.act).toHaveBeenCalledTimes(1);
      expect(runtime.cancelStrictClick).not.toHaveBeenCalled();
    });

    it("agent-owned-auto 路径不调用 onProgress", async () => {
      const runtime = fakeRuntime();
      const onProgress = vi.fn();
      const { instance } = broker(runtime, {
        approvalMode: "agent-owned-auto",
      });

      await instance.act(actInput(), observation(), { onProgress });

      expect(runtime.issueStrictClick).toHaveBeenCalledTimes(1);
      expect(onProgress).not.toHaveBeenCalled();
    });
  });
});
