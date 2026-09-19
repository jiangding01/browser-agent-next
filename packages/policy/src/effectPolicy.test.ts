import { describe, expect, it } from "vitest";
import { evaluateEffectPolicy } from "./effectPolicy.js";

describe("evaluateEffectPolicy", () => {
  it("allows read effects", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "read", confidence: "known", evidence: [] },
      tabOwnedBySession: false,
      originAllowed: true,
      hasAuthorization: false,
    }).verdict).toBe("allow");
  });

  it("requires confirmation for navigation on a user tab", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "navigation", confidence: "known", evidence: [] },
      tabOwnedBySession: false,
      originAllowed: true,
      hasAuthorization: false,
    }).verdict).toBe("confirm");
  });

  it("unknown effect 没有 hard authorization 时必须升级", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "unknown", confidence: "unknown", evidence: [] },
      tabOwnedBySession: true,
      originAllowed: true,
      hasAuthorization: false,
    }).verdict).toBe("escalate");
  });

  it("unknown effect 只有在 trusted authorization 已验证后才允许", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "unknown", confidence: "unknown", evidence: [] },
      tabOwnedBySession: true,
      originAllowed: true,
      hasAuthorization: true,
    }).verdict).toBe("allow");
  });

  it("denies disallowed origins before effect evaluation", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "read", confidence: "known", evidence: [] },
      tabOwnedBySession: true,
      originAllowed: false,
      hasAuthorization: true,
    }).verdict).toBe("deny");
  });
});
