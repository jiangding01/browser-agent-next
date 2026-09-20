import { describe, expect, it } from "vitest";
import {
  authorizationAssuranceSatisfies,
  InMemoryAuthorizationStore,
} from "./authorizationStore.js";

describe("authorizationAssuranceSatisfies", () => {
  it("按 control-plane < operator-approved < enterprise-policy 比较 assurance", () => {
    expect(authorizationAssuranceSatisfies("control-plane", "control-plane")).toBe(true);
    expect(authorizationAssuranceSatisfies("control-plane", "operator-approved")).toBe(false);
    expect(authorizationAssuranceSatisfies("operator-approved", "control-plane")).toBe(true);
    expect(authorizationAssuranceSatisfies("enterprise-policy", "operator-approved")).toBe(true);
  });
});

describe("InMemoryAuthorizationStore", () => {
  it("trusted-host 不能在 store 层伪造更高 assurance", () => {
    const store = new InMemoryAuthorizationStore({
      now: () => 1000,
    });

    expect(() => store.issue({
      id: "forged",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      assurance: "operator-approved",
      ttlMs: 5000,
      source: "trusted-host",
    })).toThrow(/cannot issue assurance/);

    expect(() => store.issue({
      id: "enterprise-forged",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      assurance: "enterprise-policy",
      ttlMs: 5000,
      source: "trusted-ui",
    })).toThrow(/cannot issue assurance/);

    // assurance label 表示来源/证明类型，不是可以随意向下重标的“等级数字”。
    expect(() => store.issue({
      id: "enterprise-mislabeled",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      assurance: "operator-approved",
      ttlMs: 5000,
      source: "enterprise-policy",
    })).toThrow(/cannot issue assurance label/);
  });

  it("授权精确绑定且默认单次消费", () => {
    const store = new InMemoryAuthorizationStore({ now: () => 1000 });
    store.issue({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown", assurance: "control-plane",
      ttlMs: 5000, source: "trusted-host",
    });
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown", minimumAssurance: "control-plane",
    }).ok).toBe(true);
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown",
    })).toEqual({ ok: false, reason: "missing" });
  });

  it("control-plane grant 不能满足 operator-approved 要求", () => {
    const store = new InMemoryAuthorizationStore({ now: () => 1000 });
    store.issue({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "payment", assurance: "control-plane",
      ttlMs: 5000, source: "trusted-host",
    });
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "payment", minimumAssurance: "operator-approved",
    })).toEqual({ ok: false, reason: "assurance-insufficient" });
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "payment", minimumAssurance: "control-plane",
    }).ok).toBe(true);
  });

  it("拒绝把授权挪用到其他 ref 或 revision", () => {
    const store = new InMemoryAuthorizationStore({ now: () => 1000 });
    store.issue({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown", assurance: "control-plane",
      ttlMs: 5000, source: "trusted-host",
    });
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_2",
      actionKind: "click", effectClass: "unknown",
    })).toEqual({ ok: false, reason: "binding-mismatch" });
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-2", ref: "@e_1",
      actionKind: "click", effectClass: "unknown",
    })).toEqual({ ok: false, reason: "binding-mismatch" });
  });

  it("过期授权不可消费", () => {
    let now = 1000;
    const store = new InMemoryAuthorizationStore({ now: () => now });
    store.issue({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown", assurance: "operator-approved",
      ttlMs: 10, source: "trusted-ui",
    });
    now = 1010;
    expect(store.consume({
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click", effectClass: "unknown",
    })).toEqual({ ok: false, reason: "expired" });
  });

  it("拒绝覆盖仍然有效的同名授权", () => {
    let now = 1000;
    const store = new InMemoryAuthorizationStore({ now: () => now });
    const input = {
      id: "grant-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
      actionKind: "click" as const, effectClass: "unknown" as const,
      assurance: "control-plane" as const, ttlMs: 100, source: "trusted-host" as const,
    };
    store.issue(input);
    expect(() => store.issue({ ...input, observedRevision: "rev-2", ref: "@e_2" })).toThrow(/already exists/);
    now = 1100;
    expect(() => store.issue({ ...input, observedRevision: "rev-2", ref: "@e_2" })).not.toThrow();
  });
});
