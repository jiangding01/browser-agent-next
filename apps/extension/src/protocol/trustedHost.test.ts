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
});
