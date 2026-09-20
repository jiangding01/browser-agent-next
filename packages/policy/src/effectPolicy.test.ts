import { describe, expect, it } from "vitest";
import { evaluateEffectPolicy, minimumAuthorizationAssurance } from "./effectPolicy.js";

describe("minimumAuthorizationAssurance", () => {
  it("unknown effect 保持 control-plane 基线", () => {
    expect(minimumAuthorizationAssurance("unknown", true)).toBe("control-plane");
  });
  it("用户已有 tab 的 navigation 至少要求 operator-approved", () => {
    expect(minimumAuthorizationAssurance("navigation", false)).toBe("operator-approved");
  });
  it("高风险已知 effect 至少要求 operator-approved", () => {
    for (const effect of ["download","external-mutation","irreversible","credential","file-egress","permission","payment"] as const) {
      expect(minimumAuthorizationAssurance(effect, true)).toBe("operator-approved");
    }
  });
});

describe("evaluateEffectPolicy", () => {
  it("read effect 不需要授权", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "read", confidence: "known", evidence: [] },
      tabOwnedBySession: false, originAllowed: true,
    }).verdict).toBe("allow");
  });
  it("用户已有 tab navigation 不接受 control-plane 代替 operator approval", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "navigation", confidence: "known", evidence: [] },
      tabOwnedBySession: false, originAllowed: true, authorizationAssurance: "control-plane",
    })).toMatchObject({ verdict: "confirm", requiredAssurance: "operator-approved" });
  });
  it("enterprise-policy 可以满足 operator-approved 最低门槛", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "payment", confidence: "known", evidence: [] },
      tabOwnedBySession: true, originAllowed: true, authorizationAssurance: "enterprise-policy",
    }).verdict).toBe("allow");
  });
  it("unknown effect 没有 authorization 时必须升级", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "unknown", confidence: "unknown", evidence: [] },
      tabOwnedBySession: true, originAllowed: true,
    }).verdict).toBe("escalate");
  });
  it("unknown effect 的 control-plane grant 维持 Strict Click 基线", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "unknown", confidence: "unknown", evidence: [] },
      tabOwnedBySession: true, originAllowed: true, authorizationAssurance: "control-plane",
    }).verdict).toBe("allow");
  });
  it("disallowed origin 优先拒绝", () => {
    expect(evaluateEffectPolicy({
      effect: { class: "read", confidence: "known", evidence: [] },
      tabOwnedBySession: true, originAllowed: false, authorizationAssurance: "enterprise-policy",
    }).verdict).toBe("deny");
  });
});
