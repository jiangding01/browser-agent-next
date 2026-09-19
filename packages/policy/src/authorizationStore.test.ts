import { describe, expect, it } from "vitest";
import { InMemoryAuthorizationStore } from "./authorizationStore.js";

describe("InMemoryAuthorizationStore", () => {
  it("授权与 tab/revision/ref/action/effect 精确绑定并默认单次消费", () => {
    let now = 1000;
    const store = new InMemoryAuthorizationStore({
      now: () => now,
    });

    store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 5000,
      source: "trusted-ui",
    });

    expect(store.consume({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
    }).ok).toBe(true);

    expect(store.consume({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
    })).toEqual({
      ok: false,
      reason: "missing",
    });

    now += 1;
  });

  it("拒绝把同一个授权挪用到其他 ref 或 revision", () => {
    const store = new InMemoryAuthorizationStore({
      now: () => 1000,
    });

    store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 5000,
      source: "trusted-host",
    });

    expect(store.consume({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_2",
      actionKind: "click",
      effectClass: "unknown",
    })).toEqual({
      ok: false,
      reason: "binding-mismatch",
    });

    expect(store.consume({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-2",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
    })).toEqual({
      ok: false,
      reason: "binding-mismatch",
    });
  });

  it("过期授权不可消费", () => {
    let now = 1000;
    const store = new InMemoryAuthorizationStore({
      now: () => now,
    });

    store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 10,
      source: "trusted-ui",
    });

    now = 1010;

    expect(store.consume({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
    })).toEqual({
      ok: false,
      reason: "expired",
    });
  });
  it("拒绝覆盖仍然有效的同名授权，避免 grant 绑定被静默改写", () => {
    let now = 1_000;
    const store = new InMemoryAuthorizationStore({
      now: () => now,
    });

    store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 100,
      source: "trusted-host",
    });

    expect(() => store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-2",
      ref: "@e_2",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 100,
      source: "trusted-host",
    })).toThrow(/already exists/);

    now = 1_100;

    expect(() => store.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-2",
      ref: "@e_2",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 100,
      source: "trusted-host",
    })).not.toThrow();
  });
});
