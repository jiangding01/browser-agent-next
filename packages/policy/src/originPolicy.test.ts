import { describe, expect, it } from "vitest";
import {
  ExactOriginAllowlist,
  MutableExactOriginAllowlist,
} from "./originPolicy.js";

describe("ExactOriginAllowlist", () => {
  it("只允许精确 origin", () => {
    const policy = new ExactOriginAllowlist([
      "https://example.com",
      "http://localhost:3000/",
    ]);

    expect(policy.isAllowed("https://example.com")).toBe(true);
    expect(policy.isAllowed("https://example.com/other")).toBe(true);
    expect(policy.isAllowed("https://evil.example.com")).toBe(false);
    expect(policy.isAllowed("http://example.com")).toBe(false);
    expect(policy.isAllowed("https://example.com:8443")).toBe(false);
    expect(policy.isAllowed("http://localhost:3000")).toBe(true);
  });

  it("拒绝把 path/query/fragment/credentials 静默扩大为整个 origin", () => {
    for (const value of [
      "https://example.com/safe",
      "https://example.com/?mode=safe",
      "https://example.com/#safe",
      "https://user:pass@example.com/",
    ]) {
      expect(
        () => new ExactOriginAllowlist([value]),
      ).toThrow(/origin-only/);
    }
  });

  it("拒绝非 http/https allowlist", () => {
    expect(
      () => new ExactOriginAllowlist(["chrome-extension://abc"]),
    ).toThrow(/http\/https/);
  });
});

describe("MutableExactOriginAllowlist", () => {
  it("默认拒绝，并且只能整组替换", () => {
    const policy = new MutableExactOriginAllowlist();

    expect(policy.isAllowed("https://example.com")).toBe(false);

    expect(policy.replace([
      "https://example.com",
      "https://second.test",
    ])).toEqual([
      "https://example.com",
      "https://second.test",
    ]);

    expect(policy.isAllowed("https://example.com/next")).toBe(true);

    policy.replace(["https://third.test"]);
    expect(policy.isAllowed("https://example.com")).toBe(false);
    expect(policy.isAllowed("https://third.test")).toBe(true);

    policy.clear();
    expect(policy.values()).toEqual([]);
  });

  it("替换失败时保留旧 allowlist，不进入半更新状态", () => {
    const policy = new MutableExactOriginAllowlist();
    policy.replace(["https://example.com"]);

    expect(() => policy.replace([
      "https://second.test",
      "https://bad.test/path",
    ])).toThrow(/origin-only/);

    expect(policy.values()).toEqual([
      "https://example.com",
    ]);
  });
});
