import { describe, expect, it } from "vitest";
import {
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
} from "./modelAccessPolicy.js";

describe("ModelToolExposurePolicy", () => {
  it("只暴露显式 browser.* allowlist", () => {
    const policy = new ModelToolExposurePolicy([
      "browser.observe",
      "browser.extract",
      "browser.open",
    ]);

    expect(policy.values()).toEqual([
      "browser.open",
      "browser.observe",
      "browser.extract",
    ]);
    expect(policy.isExposed("browser.observe")).toBe(true);
    expect(policy.isExposed("browser.wait")).toBe(false);
    expect(policy.tier("browser.open")).toBe("navigation");
    expect(policy.tier("browser.verify")).toBe("read");
  });

  it("拒绝 authorization/policy/raw control-plane 名称", () => {
    for (const name of [
      "authorization.issue-strict-click",
      "policy.replace-autoact-origins",
      "execution.execute-strict-click",
      "cdp.send",
      "browser.act",
    ]) {
      expect(
        () => new ModelToolExposurePolicy([name]),
      ).toThrow(/unknown model-facing tool/);
    }
  });
});

describe("ModelOriginAccessPolicy", () => {
  it("读取与导航使用独立 exact-origin allowlist", () => {
    const policy = new ModelOriginAccessPolicy({
      readOrigins: ["https://read.example"],
      navigationOrigins: ["https://nav.example"],
    });

    expect(policy.canRead("https://read.example/page")).toBe(true);
    expect(policy.canNavigate("https://read.example/page")).toBe(false);
    expect(policy.canNavigate("https://nav.example/path?q=1")).toBe(true);
    expect(policy.canRead("https://nav.example/path")).toBe(false);
  });

  it("模型导航拒绝 credentials、非 http(s) 与子域猜测", () => {
    const policy = new ModelOriginAccessPolicy({
      readOrigins: [],
      navigationOrigins: ["https://example.com"],
    });

    expect(policy.canNavigate("https://user:pass@example.com/")).toBe(false);
    expect(policy.canRead("https://user:pass@example.com/")).toBe(false);
    expect(policy.canNavigate("javascript:alert(1)")).toBe(false);
    expect(policy.canNavigate("https://evil.example.com/")).toBe(false);
  });
});
