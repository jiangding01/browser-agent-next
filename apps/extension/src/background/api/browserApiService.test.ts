import { describe, expect, it } from "vitest";
import {
  TabOwnershipRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import type { BrowserObservation } from "@browser-agent-next/core";
import { HighLevelBrowserApiService } from "./browserApiService.js";

function observation(id = "rev-1", url = "https://fixture.test/"): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7, title: "Fixture", url, origin: "https://fixture.test",
      ownedBySession: false,
    },
    revision: { id, stateEpoch: "runtime", documentEpoch: "doc", sequence: 1 },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: false },
    },
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollWidth: 1000, scrollHeight: 800 },
    frames: [{ frameId: "web:0", documentEpoch: "doc", accessible: true }],
    elements: [{
      ref: "@e_1", kind: "element", semantic: { role: "button", name: "Save" },
      state: { visible: true, enabled: true, focused: false },
      frameId: "web:0", capabilities: [{ kind: "click" }], provenance: { dom: true, ax: true },
    }],
  };
}

describe("HighLevelBrowserApiService", () => {
  it("browser.observe 默认使用 hybrid，未知 tab 安全降级为 user-existing", async () => {
    let received: any;
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      {
        async observe(input: unknown) {
          received = input;
          return observation();
        },
      } as never,
      {} as never,
    );

    await service.observe({ tabId: 7 });
    expect(received).toMatchObject({
      tabId: 7, ownedBySession: false, options: { includeAx: true },
    });
  });

  it("browser.open 只有真实创建的 tab 才进入 ownership registry", async () => {
    let createdInput: unknown;
    const ownership = new TabOwnershipRegistry(() => 123);
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      {
        async observe(input: any) {
          return {
            ...observation(),
            tab: {
              ...observation().tab,
              ownedBySession: input.ownedBySession,
            },
          };
        },
      } as never,
      {} as never,
      ownership,
      {
        async create(input) {
          createdInput = input;
          return {
            id: 88,
            url: input.url,
          };
        },
      },
    );

    expect(ownership.isOwned(88)).toBe(false);

    await expect(service.open({
      url: "javascript:alert(1)",
    })).rejects.toThrow(/http\/https/);

    const opened = await service.open({
      url: "https://fixture.test/start?q=1",
      active: false,
    });

    expect(opened).toEqual({
      tabId: 88,
      requestedUrl: "https://fixture.test/start?q=1",
      ownedBySession: true,
    });
    expect(createdInput).toEqual({
      url: "https://fixture.test/start?q=1",
      active: false,
    });
    expect(ownership.isOwned(88)).toBe(true);

    const observed = await service.observe({
      tabId: 88,
    });
    expect(observed.tab.ownedBySession).toBe(true);
  });

  it("browser.observe 在 service 层也拒绝无界 maxElements", async () => {
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      { async observe() { return observation(); } } as never,
      {} as never,
    );

    await expect(service.observe({
      tabId: 7,
      options: { maxElements: 501 },
    })).rejects.toThrow(/maxElements/);
  });

  it("browser.wait 在 service 层拒绝 NaN/越界 timeout 与 poll interval", async () => {
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      { async observe() { return observation(); } } as never,
      {} as never,
    );

    await expect(service.wait({
      tabId: 7,
      timeoutMs: Number.NaN,
      verification: {
        mode: "all",
        conditions: [{ type: "ref_exists", ref: "@e_1" }],
      },
    })).rejects.toThrow(/timeoutMs/);

    await expect(service.wait({
      tabId: 7,
      pollIntervalMs: 1,
      verification: {
        mode: "all",
        conditions: [{ type: "ref_exists", ref: "@e_1" }],
      },
    })).rejects.toThrow(/pollIntervalMs/);
  });

  it("browser.extract 只投影 retained observation，并显式报告截断与 missing refs", () => {
    const states = new TabStateStore();
    states.put(observation());
    const service = new HighLevelBrowserApiService(
      states,
      {} as never,
      {} as never,
    );

    expect(service.extract({
      tabId: 7,
      observedRevision: "rev-1",
      refs: ["@e_1", "@missing"],
      maxItems: 1,
    })).toMatchObject({
      revision: "rev-1",
      items: [
        {
          ref: "@e_1",
          semantic: {
            name: "Save",
          },
        },
      ],
      missingRefs: ["@missing"],
      truncated: false,
      totalMatched: 1,
      actionableCoverage: "complete",
    });

    expect(() => service.extract({
      tabId: 7,
      observedRevision: "rev-1",
      refs: Array.from(
        { length: 101 },
        (_, index) => "@e_" + index,
      ),
    })).toThrow(/refs/);
  });

  it("browser.verify 只验证指定 retained revision", () => {
    const states = new TabStateStore();
    states.put(observation());
    const service = new HighLevelBrowserApiService(states, {} as never, {} as never);
    expect(service.verify({
      tabId: 7, observedRevision: "rev-1",
      verification: { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] },
    })).toMatchObject({ verified: true, conclusive: true, revision: "rev-1" });
    expect(() => service.verify({
      tabId: 7, observedRevision: "missing",
      verification: { mode: "all", conditions: [{ type: "ref_exists", ref: "@e_1" }] },
    })).toThrow(/retained observation/);
  });

  it("browser.wait 只重试 observation/verification，不执行动作", async () => {
    let now = 0;
    let attempts = 0;
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      {
        async observe() {
          attempts += 1;
          return observation(
            "rev-" + attempts,
            attempts >= 2 ? "https://fixture.test/done" : "https://fixture.test/",
          );
        },
      } as never,
      {
        async executeStrictClickAndVerify() {
          throw new Error("must not execute");
        },
      } as never,
      undefined,
      undefined,
      {
        now: () => now,
        sleep: async (ms: number) => { now += ms; },
        defaultPollIntervalMs: 50,
      },
    );

    const result = await service.wait({
      tabId: 7, timeoutMs: 100, pollIntervalMs: 50,
      verification: {
        mode: "all",
        conditions: [{ type: "url_matches", pattern: "https://fixture.test/done" }],
      },
    });
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ timedOut: false, attempts: 2, verification: { verified: true } });
  });

  it("browser.act 在 service 层也拒绝空 verification，且不会执行动作", async () => {
    let executeCount = 0;
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      {} as never,
      {
        async executeStrictClickAndVerify() {
          executeCount += 1;
          return {};
        },
      } as never,
    );

    await expect(service.act({
      tabId: 7,
      action: {
        actionId: "a1",
        kind: "click",
        observedRevision: "rev-1",
        ref: "@e_1",
        authorizationId: "auth",
      },
      verification: {
        mode: "all",
        conditions: [],
      },
    })).rejects.toThrow(/verification/);

    expect(executeCount).toBe(0);
  });

  it("browser.act 第一版只映射现有 strict click execute+verify", async () => {
    let forwarded: any;
    const service = new HighLevelBrowserApiService(
      new TabStateStore(),
      {} as never,
      {
        async executeStrictClickAndVerify(input: unknown) {
          forwarded = input;
          return { ok: true };
        },
      } as never,
    );
    await service.act({
      tabId: 7,
      action: {
        actionId: "a1", kind: "click", observedRevision: "rev-1",
        ref: "@e_1", authorizationId: "auth-1",
      },
      verification: { mode: "all", conditions: [{ type: "ref_absent", ref: "@e_1" }] },
    });
    expect(forwarded).toMatchObject({
      actionId: "a1", authorizationId: "auth-1", tabId: 7, observedRevision: "rev-1", ref: "@e_1",
    });
  });
});
