import { describe, expect, it } from "vitest";
import { ExactOriginAllowlist } from "./originPolicy.js";

describe("ExactOriginAllowlist", () => {
  it("只允许精确 scheme + host + port origin", () => {
    const policy = new ExactOriginAllowlist([
      "https://example.test/path?ignored=1",
      "http://localhost:4173",
    ]);

    expect(policy.isAllowed("https://example.test")).toBe(true);
    expect(policy.isAllowed("https://example.test/other")).toBe(true);
    expect(policy.isAllowed("http://localhost:4173")).toBe(true);

    expect(policy.isAllowed("http://example.test")).toBe(false);
    expect(policy.isAllowed("https://example.test:8443")).toBe(false);
    expect(policy.isAllowed("https://evil.example.test")).toBe(false);
  });

  it("拒绝 opaque / 非 http(s) origin", () => {
    const policy = new ExactOriginAllowlist([]);

    expect(policy.isAllowed("null")).toBe(false);
    expect(policy.isAllowed("file:///tmp/a.html")).toBe(false);
    expect(policy.isAllowed("chrome-extension://abc")).toBe(false);

    expect(
      () => new ExactOriginAllowlist(["file:///tmp/a.html"]),
    ).toThrow(/http\/https/);
  });

  it("默认空集合意味着 fail closed", () => {
    const policy = new ExactOriginAllowlist([]);
    expect(policy.isAllowed("https://example.test")).toBe(false);
  });
});
