import { describe, expect, it } from "vitest";
import {
  ExactOriginAllowlist,
  MutableExactOriginAllowlist,
} from "./originPolicy.js";

describe("ExactOriginAllowlist", () => {
  it("只允许精确 origin", () => {
    const policy = new ExactOriginAllowlist([
      "https://example.com/path",
      "http://localhost:3000/",
    ]);

    expect(policy.isAllowed("https://example.com")).toBe(true);
    expect(policy.isAllowed("https://example.com/other")).toBe(true);
    expect(policy.isAllowed("https://evil.example.com")).toBe(false);
    expect(policy.isAllowed("http://example.com")).toBe(false);
    expect(policy.isAllowed("https://example.com:8443")).toBe(false);
    expect(policy.isAllowed("http://localhost:3000")).toBe(true);
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
      "https://example.com/path",
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
});
