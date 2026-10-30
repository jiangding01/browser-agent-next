import { describe, expect, it } from "vitest";
import { connectTrustedNativeIngress } from "./trustedNativeIngress.js";

describe("connectTrustedNativeIngress", () => {
  it("native host 缺失时安全降级为没有执行入口", () => {
    const connection = connectTrustedNativeIngress(
      {
        connectNative() {
          throw new Error("host not found");
        },
      },
      {} as never,
    );

    expect(connection.connected).toBe(false);
  });

  it("只有通过 trusted native port 的请求才能进入 issue/execute service", async () => {
    let listener: ((message: unknown) => void) | undefined;
    const responses: unknown[] = [];

    const service = {
      replaceAutoActOrigins(origins: string[]) {
        return origins;
      },
      issueStrictClickAuthorization() {
        return {
          id: "auth",
          expiresAt: 1_000,
          origin: "https://fixture.test",
          assurance: "control-plane",
        };
      },
      async executeStrictClickAndVerify() {
        return {
          execution: { status: "executed" },
          verification: {
            verified: true,
            conclusive: true,
            evidence: [],
          },
          verificationAttempts: 1,
        };
      },
    };

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage(message: unknown) {
              responses.push(message);
            },
            disconnect() {},
            onMessage: {
              addListener(next: (message: unknown) => void) {
                listener = next;
              },
              removeListener() {},
            },
            onDisconnect: {
              addListener() {},
              removeListener() {},
            },
          };
        },
      },
      service as never,
    );

    listener?.({
      type: "authorization.issue-strict-click",
      requestId: "req-1",
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(responses).toContainEqual({
      type: "trusted-host.result",
      requestId: "req-1",
      ok: true,
      result: {
        id: "auth",
        expiresAt: 1_000,
        origin: "https://fixture.test",
        assurance: "control-plane",
      },
    });
  });
  it("control-plane 只能 request/status operator approval，不能直接 approve", async () => {
    let listener:
      | ((message: unknown) => void)
      | undefined;
    const responses: any[] = [];
    const calls: string[] = [];

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage(message: unknown) {
              responses.push(message);
            },
            disconnect() {},
            onMessage: {
              addListener(
                next: (message: unknown) => void,
              ) {
                listener = next;
              },
              removeListener() {},
            },
            onDisconnect: {
              addListener() {},
              removeListener() {},
            },
          };
        },
      },
      {
        requestOperatorApproval() {
          calls.push("request");
          return {
            approvalRequestId: "operator-1",
            state: "pending",
          };
        },
        operatorApprovalStatus() {
          calls.push("status");
          return {
            approvalRequestId: "operator-1",
            state: "pending",
          };
        },
      } as never,
    );

    listener?.({
      type: "authorization.request-operator-approval",
      requestId: "request",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    });

    listener?.({
      type: "authorization.operator-approval-status",
      requestId: "status",
      approvalRequestId: "operator-1",
    });

    // 不存在 trusted-host approve 消息类型。
    listener?.({
      type: "authorization.approve-operator",
      requestId: "forged",
      approvalRequestId: "operator-1",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      "request",
      "status",
    ]);
    expect(
      responses.some(
        (response) =>
          response.requestId === "forged" &&
          response.ok === false,
      ),
    ).toBe(true);
  });

  it("enterprise assertion 只作为签名证明转发，不能自报 enterprise grant", async () => {
    let listener:
      | ((message: unknown) => void)
      | undefined;
    const responses: any[] = [];
    const received: any[] = [];

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage(message: unknown) {
              responses.push(message);
            },
            disconnect() {},
            onMessage: {
              addListener(
                next: (message: unknown) => void,
              ) {
                listener = next;
              },
              removeListener() {},
            },
            onDisconnect: {
              addListener() {},
              removeListener() {},
            },
          };
        },
      },
      {
        async issueEnterprisePolicyAuthorization(
          envelope: unknown,
        ) {
          received.push(envelope);
          return {
            id: "auth-enterprise",
            assurance:
              "enterprise-policy",
          };
        },
      } as never,
    );

    const assertion = {
      version: 1,
      assertionId: "assertion-1",
      keyId: "enterprise-key-1",
      authorizationId: "auth-enterprise",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      origin: "https://fixture.test",
      actionKind: "click",
      effectClass: "unknown",
      issuedAt: 1000,
      expiresAt: 61000,
      grantTtlMs: 30000,
    };

    listener?.({
      type: "authorization.issue-enterprise-policy",
      requestId: "enterprise",
      assertion,
      signature: "A".repeat(86),
    });

    await new Promise<void>(
      (resolve) =>
        setTimeout(resolve, 0),
    );

    expect(received).toEqual([{
      assertion,
      signature: "A".repeat(86),
    }]);
    expect(responses).toContainEqual({
      type: "trusted-host.result",
      requestId: "enterprise",
      ok: true,
      result: {
        id: "auth-enterprise",
        assurance:
          "enterprise-policy",
      },
    });
  });

  it("高层 browser.observe/verify/wait/act 通过同一 trusted ingress 路由", async () => {
    let listener: ((message: unknown) => void) | undefined;
    const responses: any[] = [];
    const calls: string[] = [];
    const port = {
      postMessage(message: unknown) { responses.push(message); },
      disconnect() {},
      onMessage: { addListener(next: (message: unknown) => void) { listener = next; }, removeListener() {} },
      onDisconnect: { addListener() {}, removeListener() {} },
    };
    const browserApi = {
      async observe() { calls.push("observe"); return { revision: { id: "rev-1" } }; },
      verify() { calls.push("verify"); return { verified: true, conclusive: true, evidence: [] }; },
      async wait() { calls.push("wait"); return { timedOut: false, attempts: 1, verification: { verified: true } }; },
      async act() { calls.push("act"); return { execution: { status: "executed" } }; },
    };
    connectTrustedNativeIngress(
      { connectNative() { return port; } },
      { replaceAutoActOrigins() { return []; } } as never,
      browserApi as never,
    );
    const verification = { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] };
    listener?.({ type: "browser.observe", requestId: "o", tabId: 7 });
    listener?.({ type: "browser.verify", requestId: "v", tabId: 7, observedRevision: "rev-1", verification });
    listener?.({ type: "browser.wait", requestId: "w", tabId: 7, verification });
    listener?.({
      type: "browser.act", requestId: "a", tabId: 7,
      action: { actionId: "a1", kind: "click", observedRevision: "rev-1", ref: "@e_1", authorizationId: "auth" },
      verification,
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(calls.sort()).toEqual(["act", "observe", "verify", "wait"]);
    expect(responses.filter((response) => response.ok === true)).toHaveLength(4);
  });

  it("断连后不发送延迟完成请求的回包", async () => {
    let listener: ((message: unknown) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let resolveRequest: ((value: unknown) => void) | undefined;
    let issueCalls = 0;
    const responses: unknown[] = [];

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage(message: unknown) { responses.push(message); },
            disconnect() {},
            onMessage: {
              addListener(next: (message: unknown) => void) { listener = next; },
              removeListener() {},
            },
            onDisconnect: {
              addListener(next: () => void) { onDisconnect = next; },
              removeListener() {},
            },
          };
        },
      },
      {
        async issueStrictClickAuthorization() {
          issueCalls += 1;
          return new Promise((resolve) => { resolveRequest = resolve; });
        },
      } as never,
    );

    listener?.({
      type: "authorization.issue-strict-click",
      requestId: "req-1",
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    });

    expect(onDisconnect).toBeTypeOf("function");
    expect(issueCalls).toBe(1);
    expect(resolveRequest).toBeTypeOf("function");
    if (!resolveRequest) throw new Error("request resolver was not installed");
    onDisconnect?.();
    resolveRequest({ id: "auth" });
    await Promise.resolve();
    await Promise.resolve();

    expect(responses).toEqual([]);
  });

  it("suppresses a native postMessage failure after a completed request", async () => {
    let listener: ((message: unknown) => void) | undefined;

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage() { throw new Error("native port closed"); },
            disconnect() {},
            onMessage: {
              addListener(next: (message: unknown) => void) { listener = next; },
              removeListener() {},
            },
            onDisconnect: { addListener() {}, removeListener() {} },
          };
        },
      },
      { replaceAutoActOrigins() { return []; } } as never,
    );

    listener?.({
      type: "policy.replace-autoact-origins",
      requestId: "req-1",
      origins: [],
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  describe("cancel 与 approvalTtlMs 分发", () => {
    function connectWithService(service: Record<string, unknown>) {
      let listener: ((message: unknown) => void) | undefined;
      const responses: any[] = [];

      connectTrustedNativeIngress(
        {
          connectNative() {
            return {
              postMessage(message: unknown) {
                responses.push(message);
              },
              disconnect() {},
              onMessage: {
                addListener(next: (message: unknown) => void) {
                  listener = next;
                },
                removeListener() {},
              },
              onDisconnect: {
                addListener() {},
                removeListener() {},
              },
            };
          },
        },
        service as never,
      );

      return {
        responses,
        send(message: unknown) {
          listener?.(message);
        },
      };
    }

    async function flush() {
      await Promise.resolve();
      await Promise.resolve();
    }

    it("authorization.cancel-strict-click 分发到 service.cancelStrictClickAuthorization 并返回结果", async () => {
      const calls: string[] = [];
      const { responses, send } = connectWithService({
        cancelStrictClickAuthorization(authorizationId: string) {
          calls.push(authorizationId);
          return { authorizationId };
        },
      });

      send({
        type: "authorization.cancel-strict-click",
        requestId: "cancel-1",
        authorizationId: "auth-1",
      });
      await flush();

      expect(calls).toEqual(["auth-1"]);
      expect(responses).toContainEqual({
        type: "trusted-host.result",
        requestId: "cancel-1",
        ok: true,
        result: { authorizationId: "auth-1" },
      });
    });

    it("cancel 请求夹带多余 key 时不会触达 service", async () => {
      const calls: string[] = [];
      const { responses, send } = connectWithService({
        cancelStrictClickAuthorization(authorizationId: string) {
          calls.push(authorizationId);
          return { authorizationId };
        },
      });

      send({
        type: "authorization.cancel-strict-click",
        requestId: "cancel-bad",
        authorizationId: "auth-1",
        extra: true,
      });
      await flush();

      expect(calls).toEqual([]);
      expect(responses.some(
        (response) =>
          response.requestId === "cancel-bad" && response.ok === false,
      )).toBe(true);
    });

    it("approvalTtlMs 透传给 requestOperatorApproval，未提供时不出现该 key", async () => {
      const inputs: Record<string, unknown>[] = [];
      const { send } = connectWithService({
        requestOperatorApproval(input: Record<string, unknown>) {
          inputs.push(input);
          return { approvalRequestId: "operator-1" };
        },
      });

      const base = {
        type: "authorization.request-operator-approval",
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        ttlMs: 1_000,
      };

      send({ ...base, requestId: "with-ttl", approvalTtlMs: 30_000 });
      send({ ...base, requestId: "without-ttl" });
      await flush();

      expect(inputs).toEqual([
        {
          authorizationId: "auth-1",
          tabId: 7,
          observedRevision: "rev-1",
          ref: "@e_1",
          ttlMs: 1_000,
          approvalTtlMs: 30_000,
        },
        {
          authorizationId: "auth-1",
          tabId: 7,
          observedRevision: "rev-1",
          ref: "@e_1",
          ttlMs: 1_000,
        },
      ]);
      expect(inputs[1]).not.toHaveProperty("approvalTtlMs");
    });
  });
});

describe("connectTrustedNativeIngress strict-action 消息", () => {
  it("三条新消息把 action 原样交给 service", async () => {
    let listener: ((message: unknown) => void) | undefined;
    const calls: Array<[string, unknown]> = [];
    const service = {
      issueStrictClickAuthorization(input: unknown) {
        calls.push(["issue", input]);
        return { id: "auth" };
      },
      requestOperatorApproval(input: unknown) {
        calls.push(["approval", input]);
        return { approvalRequestId: "approval-1" };
      },
      async executeStrictClickAndVerify(input: unknown) {
        calls.push(["execute", input]);
        return { execution: { status: "executed", valueMatched: true } };
      },
    };
    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage() {},
            disconnect() {},
            onMessage: {
              addListener(next: (message: unknown) => void) {
                listener = next;
              },
              removeListener() {},
            },
            onDisconnect: { addListener() {}, removeListener() {} },
          };
        },
      },
      service as never,
    );

    const action = { kind: "setValue", value: "张三" };
    const common = {
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
    };
    listener?.({ type: "authorization.issue-strict-action", requestId: "r1", ...common, ttlMs: 1_000, action });
    listener?.({
      type: "authorization.request-strict-action-approval",
      requestId: "r2",
      ...common,
      ttlMs: 1_000,
      approvalTtlMs: 5_000,
      action,
    });
    listener?.({
      type: "execution.execute-strict-action",
      requestId: "r3",
      ...common,
      actionId: "a-1",
      action,
      verification: { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      ["issue", { ...common, ttlMs: 1_000, action }],
      ["approval", { ...common, ttlMs: 1_000, approvalTtlMs: 5_000, action }],
      [
        "execute",
        {
          ...common,
          actionId: "a-1",
          action,
          verification: { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] },
        },
      ],
    ]);
  });
});
