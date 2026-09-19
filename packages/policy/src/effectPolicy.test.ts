import { describe, expect, it } from "vitest";
import { evaluateEffectPolicy } from "./effectPolicy.js";

describe("evaluateEffectPolicy", () => {
  it("allows read effects", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "read", confidence: "known", evidence: [] },
      tabOwnedBySession: false, originAllowed: true, hasAuthorization: false,
    }).verdict).toBe("allow");
  });

  it("requires confirmation for navigation on a user tab", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "navigation", confidence: "known", evidence: [] },
      tabOwnedBySession: false, originAllowed: true, hasAuthorization: false,
    }).verdict).toBe("confirm");
  });

  it("never treats unknown effect as low risk", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "unknown", confidence: "unknown", evidence: [] },
      tabOwnedBySession: true, originAllowed: true, hasAuthorization: false,
    }).verdict).toBe("escalate");
  });
});
