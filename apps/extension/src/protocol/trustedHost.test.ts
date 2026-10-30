import { describe, expect, it } from "vitest";
import { isTrustedHostRequest } from "./trustedHost.js";

describe("isTrustedHostRequest", () => {
  it("browser.open 只接受有界 envelope，URL scheme 由 service 层继续验证", () => {
    expect(isTrustedHostRequest({
      type: "browser.open",
      requestId: "open",
      url: "https://example.test/",
      active: false,
    })).toBe(true);

    expect(isTrustedHostRequest({
      type: "browser.open",
      requestId: "open",
      url: "",
    })).toBe(false);

    expect(isTrustedHostRequest({
      type: "browser.open",
      requestId: "open",
      url: "x".repeat(2049),
    })).toBe(false);
  });

  it("接受有界的 browser.observe 请求，且不存在 ownedBySession 字段", () => {
    expect(isTrustedHostRequest({
      type: "browser.observe", requestId: "req", tabId: 7,
      options: { profile: "hybrid", maxElements: 500, maxAxElements: 500 },
    })).toBe(true);
    expect(isTrustedHostRequest({
      type: "browser.observe", requestId: "req", tabId: 7,
      options: { maxElements: 501 },
    })).toBe(false);
  });

  it("接受 browser.extract / verify / wait / act 的有界 schema", () => {
    const verification = {
      mode: "all",
      conditions: [{ type: "ref_exists", ref: "@e_1" }],
    };
    expect(isTrustedHostRequest({
      type: "browser.extract",
      requestId: "x",
      tabId: 7,
      observedRevision: "rev-1",
      refs: ["@e_1"],
      maxItems: 10,
    })).toBe(true);
    expect(isTrustedHostRequest({
      type: "browser.extract",
      requestId: "x",
      tabId: 7,
      observedRevision: "rev-1",
      refs: Array.from({ length: 101 }, (_, index) => "@e_" + index),
    })).toBe(false);
    expect(isTrustedHostRequest({
      type: "browser.verify", requestId: "v", tabId: 7, observedRevision: "rev-1", verification,
    })).toBe(true);
    expect(isTrustedHostRequest({
      type: "browser.wait", requestId: "w", tabId: 7, verification, timeoutMs: 1000, pollIntervalMs: 100,
    })).toBe(true);
    expect(isTrustedHostRequest({
      type: "browser.act", requestId: "a", tabId: 7,
      action: { actionId: "a1", kind: "click", observedRevision: "rev-1", ref: "@e_1", authorizationId: "auth-1" },
      verification,
    })).toBe(true);
  });

  it("operator approval request 不能自报 assurance/source", () => {
    expect(isTrustedHostRequest({
      type: "authorization.request-operator-approval",
      requestId: "op",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1000,
    })).toBe(true);

    expect(isTrustedHostRequest({
      type: "authorization.operator-approval-status",
      requestId: "status",
      approvalRequestId: "operator-1",
    })).toBe(true);

    expect(isTrustedHostRequest({
      type: "authorization.request-operator-approval",
      requestId: "op",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1000,
      assurance: "operator-approved",
    })).toBe(false);

    expect(isTrustedHostRequest({
      type: "authorization.request-operator-approval",
      requestId: "op",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1000,
      source: "trusted-ui",
    })).toBe(false);
  });

  it("enterprise policy request 必须携带完整签名 assertion，且不能夹带 provenance", () => {
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

    expect(isTrustedHostRequest({
      type: "authorization.issue-enterprise-policy",
      requestId: "enterprise",
      assertion,
      signature: "A".repeat(86),
    })).toBe(true);

    expect(isTrustedHostRequest({
      type: "authorization.issue-enterprise-policy",
      requestId: "enterprise",
      assertion: {
        ...assertion,
        assurance: "enterprise-policy",
      },
      signature: "A".repeat(86),
    })).toBe(false);

    expect(isTrustedHostRequest({
      type: "authorization.issue-enterprise-policy",
      requestId: "enterprise",
      assertion,
      signature: "A".repeat(86),
      source: "enterprise-policy",
    })).toBe(false);
  });

  it("browser.act 不接受调用方伪造 assurance", () => {
    const verification = { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] };
    expect(isTrustedHostRequest({
      type: "browser.act", requestId: "a", tabId: 7,
      action: { actionId: "a1", kind: "click", observedRevision: "rev-1", ref: "@e_1", authorizationId: "auth", assurance: "enterprise-policy" },
      verification,
    })).toBe(false);

    expect(isTrustedHostRequest({
      type: "authorization.issue-strict-click",
      requestId: "auth",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1000,
      assurance: "operator-approved",
    })).toBe(false);
  });

  it("browser.act 当前拒绝非 click action", () => {
    const verification = { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] };
    expect(isTrustedHostRequest({
      type: "browser.act", requestId: "a", tabId: 7,
      action: { actionId: "a1", kind: "submit", observedRevision: "rev-1", ref: "@e_1", authorizationId: "auth" },
      verification,
    })).toBe(false);
  });

  it("拒绝空 verification，避免执行后没有独立 postcondition", () => {
    expect(isTrustedHostRequest({
      type: "execution.execute-strict-click", requestId: "req-1",
      actionId: "action-1", authorizationId: "auth-1", tabId: 7,
      observedRevision: "rev-1", ref: "@e_1",
      verification: { mode: "all", conditions: [] },
    })).toBe(false);
  });

  it("限制 allowlist 一次同步数量", () => {
    expect(isTrustedHostRequest({
      type: "policy.replace-autoact-origins", requestId: "req",
      origins: Array.from({ length: 101 }, (_, index) => "https://example" + index + ".test"),
    })).toBe(false);
  });

  it("request-operator-approval 的 approvalTtlMs 必须是 1..120000 的整数，缺省合法", () => {
    const base = {
      type: "authorization.request-operator-approval",
      requestId: "op",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1000,
    };

    expect(isTrustedHostRequest(base)).toBe(true);
    expect(isTrustedHostRequest({ ...base, approvalTtlMs: 1 })).toBe(true);
    expect(isTrustedHostRequest({ ...base, approvalTtlMs: 120_000 })).toBe(true);

    for (const approvalTtlMs of [0, -1, 120_001, 1.5, "1000", null, Number.NaN]) {
      expect(isTrustedHostRequest({ ...base, approvalTtlMs })).toBe(false);
    }
  });

  it("authorization.cancel-strict-click 只接受 type/requestId/authorizationId", () => {
    const base = {
      type: "authorization.cancel-strict-click",
      requestId: "cancel",
      authorizationId: "auth-1",
    };

    expect(isTrustedHostRequest(base)).toBe(true);
    expect(isTrustedHostRequest({
      ...base,
      authorizationId: "a".repeat(256),
    })).toBe(true);

    expect(isTrustedHostRequest({ ...base, authorizationId: "" })).toBe(false);
    expect(isTrustedHostRequest({
      ...base,
      authorizationId: "a".repeat(257),
    })).toBe(false);
    expect(isTrustedHostRequest({ ...base, authorizationId: 1 })).toBe(false);
    expect(isTrustedHostRequest({
      type: base.type,
      requestId: base.requestId,
    })).toBe(false);
    expect(isTrustedHostRequest({ ...base, extra: "x" })).toBe(false);
    expect(isTrustedHostRequest({ ...base, tabId: 7 })).toBe(false);
    expect(isTrustedHostRequest({ ...base, assurance: "operator-approved" })).toBe(false);
    expect(isTrustedHostRequest({ ...base, requestId: "" })).toBe(false);
  });
});

describe("isTrustedHostRequest strict-action 消息", () => {
  const setValue = { kind: "setValue", value: "张三" };
  const verification = { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] };
  const issue = {
    type: "authorization.issue-strict-action",
    requestId: "r",
    authorizationId: "auth-1",
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@e_1",
    ttlMs: 1_000,
    action: setValue,
  };
  const approval = {
    ...issue,
    type: "authorization.request-strict-action-approval",
    approvalTtlMs: 30_000,
  };
  const execute = {
    type: "execution.execute-strict-action",
    requestId: "r",
    actionId: "a-1",
    authorizationId: "auth-1",
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@e_1",
    action: setValue,
    verification,
  };

  it("接受合法的三条新消息，click 也可走同一入口", () => {
    for (const message of [issue, approval, execute]) {
      expect(isTrustedHostRequest(message), message.type).toBe(true);
      expect(isTrustedHostRequest({ ...message, action: { kind: "click" } }), message.type).toBe(true);
    }
  });

  it("exact-key：多余字段、缺少 action 或非法 action 一律拒绝", () => {
    for (const message of [issue, approval, execute]) {
      expect(isTrustedHostRequest({ ...message, assurance: "operator-approved" })).toBe(false);
      expect(isTrustedHostRequest({ ...message, source: "trusted-ui" })).toBe(false);
      const { action: _action, ...withoutAction } = message;
      expect(isTrustedHostRequest(withoutAction)).toBe(false);
      for (const action of [
        { kind: "type", value: "x" },
        { kind: "setValue" },
        { kind: "setValue", value: "line\nbreak" },
        { kind: "setValue", value: "zero​width" },
        { kind: "setValue", value: "x".repeat(1_025) },
        { kind: "click", value: "x" },
      ]) {
        expect(isTrustedHostRequest({ ...message, action }), JSON.stringify(action)).toBe(false);
      }
    }
  });

  it("旧 click 消息携带 action 时拒绝，不会被当成 click 执行", () => {
    for (const message of [
      { ...issue, type: "authorization.issue-strict-click" },
      { ...approval, type: "authorization.request-operator-approval" },
      { ...execute, type: "execution.execute-strict-click" },
    ]) {
      expect(isTrustedHostRequest(message), message.type).toBe(false);
      const { action: _action, ...legacy } = message;
      expect(isTrustedHostRequest(legacy), message.type).toBe(true);
    }
  });

  it("browser.act 的 setValue 必须带合法值，click 不得带值", () => {
    const act = (action: Record<string, unknown>) =>
      isTrustedHostRequest({
        type: "browser.act",
        requestId: "r",
        tabId: 7,
        action: {
          actionId: "a-1",
          observedRevision: "rev-1",
          ref: "@e_1",
          authorizationId: "auth-1",
          ...action,
        },
        verification,
      });

    expect(act({ kind: "setValue", value: "张三" })).toBe(true);
    expect(act({ kind: "setValue", value: "" })).toBe(true);
    expect(act({ kind: "setValue" })).toBe(false);
    expect(act({ kind: "setValue", value: "a‮b" })).toBe(false);
    expect(act({ kind: "click" })).toBe(true);
    expect(act({ kind: "click", value: "x" })).toBe(false);
    expect(act({ kind: "selectOption", value: "x" })).toBe(false);
  });
});
