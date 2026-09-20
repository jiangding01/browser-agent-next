import { describe, expect, it } from "vitest";
import {
  InMemoryAuthorizationStore,
  MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import { TabStateStore } from "@browser-agent-next/runtime";
import type { BrowserObservation } from "@browser-agent-next/core";
import { TrustedHostExecutionService } from "./trustedHostExecutionService.js";

function observation(): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://fixture.test/",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    revision: {
      id: "rev-1",
      stateEpoch: "runtime",
      documentEpoch: "doc",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: false },
    },
    viewport: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1000,
      scrollHeight: 800,
    },
    frames: [{
      frameId: "web:0",
      documentEpoch: "doc",
      accessible: true,
    }],
    elements: [{
      ref: "@e_1",
      kind: "element",
      semantic: { role: "button", name: "Save" },
      state: { visible: true, enabled: true, focused: false },
      frameId: "web:0",
      capabilities: [{ kind: "click" }],
      provenance: { dom: true, ax: true },
    }],
  };
}

describe("TrustedHostExecutionService", () => {
  it("只有 allowlisted retained target 才能签发短期授权", () => {
    const states = new TabStateStore();
    states.put(observation());
    const origins = new MutableExactOriginAllowlist();
    origins.replace(["https://fixture.test"]);

    const authorizations = new InMemoryAuthorizationStore({
      now: () => 100,
    });

    const service = new TrustedHostExecutionService(
      states,
      authorizations,
      origins,
      { execute: async () => { throw new Error("not used"); } } as never,
      { observe: async () => { throw new Error("not used"); } } as never,
    );

    expect(service.issueStrictClickAuthorization({
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    })).toEqual({
      id: "auth-1",
      expiresAt: 1_100,
      origin: "https://fixture.test",
      assurance: "control-plane",
    });
  });

  it("用户已有 tab 的 unknown click 不能由 control-plane grant 自行授权", () => {
    const states = new TabStateStore();
    states.put({
      ...observation(),
      tab: {
        ...observation().tab,
        ownedBySession: false,
      },
    });

    const origins = new MutableExactOriginAllowlist();
    origins.replace(["https://fixture.test"]);

    const service = new TrustedHostExecutionService(
      states,
      new InMemoryAuthorizationStore(),
      origins,
      {} as never,
      {} as never,
    );

    expect(() => service.issueStrictClickAuthorization({
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    })).toThrow(/required assurance: operator-approved/);
  });

  it("未 allowlist 的 origin 无法被 trusted host grant 绕过", () => {
    const states = new TabStateStore();
    states.put(observation());

    const service = new TrustedHostExecutionService(
      states,
      new InMemoryAuthorizationStore(),
      new MutableExactOriginAllowlist(),
      {} as never,
      {} as never,
    );

    expect(() => service.issueStrictClickAuthorization({
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    })).toThrow(/outside the auto-act allowlist/);
  });

  it("执行动作后只重试 observation，不重放 click", async () => {
    const states = new TabStateStore();
    states.put(observation());

    const origins = new MutableExactOriginAllowlist();
    origins.replace(["https://fixture.test"]);

    let executeCount = 0;
    let observeCount = 0;
    let now = 0;

    const service = new TrustedHostExecutionService(
      states,
      new InMemoryAuthorizationStore(),
      origins,
      {
        async execute() {
          executeCount += 1;
          return {
            actionId: "action",
            status: "executed",
            observedRevision: "rev-1",
            ref: "@e_1",
            effect: {
              class: "unknown",
              confidence: "unknown",
              evidence: [],
            },
          };
        },
      } as never,
      {
        async observe() {
          observeCount += 1;
          if (observeCount === 1) {
            throw new Error("navigation race");
          }

          return {
            ...observation(),
            tab: {
              ...observation().tab,
              url: "https://fixture.test/done",
            },
            revision: {
              ...observation().revision,
              id: "rev-2",
              sequence: 2,
            },
          };
        },
      } as never,
      {
        now: () => now,
        pollIntervalMs: 10,
        maxVerifyTimeoutMs: 100,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    const result = await service.executeStrictClickAndVerify({
      actionId: "action",
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      verification: {
        mode: "all",
        conditions: [{
          type: "url_matches",
          pattern: "https://fixture.test/done",
        }],
      },
      verifyTimeoutMs: 50,
    });

    expect(executeCount).toBe(1);
    expect(observeCount).toBe(2);
    expect(result.verification).toMatchObject({
      verified: true,
      conclusive: true,
    });
    expect(result.freshRevision).toBe("rev-2");
  });
});
