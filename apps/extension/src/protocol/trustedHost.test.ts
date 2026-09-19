import { describe, expect, it } from "vitest";
import { isTrustedHostRequest } from "./trustedHost.js";

describe("isTrustedHostRequest", () => {
  it("接受有界的 trusted click execute 请求", () => {
    expect(isTrustedHostRequest({
      type: "execution.execute-strict-click",
      requestId: "req-1",
      actionId: "action-1",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      verification: {
        mode: "all",
        conditions: [{
          type: "url_matches",
          pattern: "https://example.test/done*",
        }],
      },
      verifyTimeoutMs: 1500,
    })).toBe(true);
  });

  it("拒绝空 verification，避免执行后没有独立 postcondition", () => {
    expect(isTrustedHostRequest({
      type: "execution.execute-strict-click",
      requestId: "req-1",
      actionId: "action-1",
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      verification: {
        mode: "all",
        conditions: [],
      },
    })).toBe(false);
  });

  it("限制 allowlist 一次同步数量", () => {
    expect(isTrustedHostRequest({
      type: "policy.replace-autoact-origins",
      requestId: "req",
      origins: Array.from(
        { length: 101 },
        (_, index) => "https://example" + index + ".test",
      ),
    })).toBe(false);
  });
});
