import { describe, expect, it } from "vitest";
import { isTrustedHostRequest } from "./trustedHost.js";

describe("isTrustedHostRequest", () => {
  it("接受有界的 browser.observe 请求，且不存在 ownedBySession 字段", () => {
    expect(isTrustedHostRequest({
      type: "browser.observe", requestId: "req", tabId: 7,
      options: { profile: "hybrid", maxElements: 500, maxAxElements: 500 },
    })).toBe(true);
    expect(isTrustedHostRequest({
      type: "browser.observe", requestId: "req", tabId: 7,
      options: { maxElements: 5001 },
    })).toBe(false);
  });

  it("接受 browser.verify / wait / act 的有界 schema", () => {
    const verification = {
      mode: "all",
      conditions: [{ type: "ref_exists", ref: "@e_1" }],
    };
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
