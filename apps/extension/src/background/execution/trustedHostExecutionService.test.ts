import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuthorizationStore,
  MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import { TabStateStore } from "@browser-agent-next/runtime";
import type { BrowserObservation } from "@browser-agent-next/core";
import { TrustedHostExecutionService } from "./trustedHostExecutionService.js";
import { OperatorApprovalStore } from "./operatorApprovalStore.js";
import {
  StrictClickAuthorizationIssuanceService,
} from "./authorizationIssuanceService.js";

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
      origins,
      new StrictClickAuthorizationIssuanceService(
        states,
        authorizations,
        origins,
      ),
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

    const authorizations =
      new InMemoryAuthorizationStore();

    const service = new TrustedHostExecutionService(
      states,
      origins,
      new StrictClickAuthorizationIssuanceService(
        states,
        authorizations,
        origins,
      ),
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

    const origins =
      new MutableExactOriginAllowlist();
    const authorizations =
      new InMemoryAuthorizationStore();

    const service = new TrustedHostExecutionService(
      states,
      origins,
      new StrictClickAuthorizationIssuanceService(
        states,
        authorizations,
        origins,
      ),
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

    const authorizations =
      new InMemoryAuthorizationStore();

    const service = new TrustedHostExecutionService(
      states,
      origins,
      new StrictClickAuthorizationIssuanceService(
        states,
        authorizations,
        origins,
      ),
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

  describe("cancelStrictClickAuthorization", () => {
    function buildCancelFixture(
      options: { maxCancelledAuthorizationIds?: number } = {},
    ) {
      const states = new TabStateStore();
      states.put(observation());
      const origins = new MutableExactOriginAllowlist();
      origins.replace(["https://fixture.test"]);
      let now = 100;
      const authorizations = new InMemoryAuthorizationStore({
        now: () => now,
      });
      const issuance = new StrictClickAuthorizationIssuanceService(
        states,
        authorizations,
        origins,
      );
      let approvalSeq = 0;
      const operatorApprovals = new OperatorApprovalStore(
        states,
        origins,
        issuance,
        {
          now: () => now,
          idFactory: () => {
            approvalSeq += 1;
            return `approval-${approvalSeq}`;
          },
        },
      );
      const service = new TrustedHostExecutionService(
        states,
        origins,
        issuance,
        {} as never,
        {} as never,
        {
          now: () => now,
          operatorApprovals,
          ...options,
        },
      );

      const target = {
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        ttlMs: 1_000,
      };
      const consumeInput = {
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "click" as const,
        effectClass: "unknown" as const,
      };

      return {
        service,
        authorizations,
        operatorApprovals,
        target,
        consumeInput,
        setNow(value: number) {
          now = value;
        },
      };
    }

    it("cancel 后同 id 的企业策略签发也被拒，且不触达企业签发服务", async () => {
      const states = new TabStateStore();
      const origins = new MutableExactOriginAllowlist();
      const issuance = new StrictClickAuthorizationIssuanceService(
        states,
        new InMemoryAuthorizationStore(),
        origins,
      );
      const enterpriseIssue = vi.fn();
      const service = new TrustedHostExecutionService(
        states,
        origins,
        issuance,
        {} as never,
        {} as never,
        {
          enterprisePolicyAuthorization: {
            issue: enterpriseIssue,
          } as never,
        },
      );

      service.cancelStrictClickAuthorization("auth-ent");

      await expect(service.issueEnterprisePolicyAuthorization({
        assertion: { authorizationId: "auth-ent" },
        signature: "sig",
      } as never)).rejects.toThrow(/authorization id was cancelled/);
      expect(enterpriseIssue).not.toHaveBeenCalled();
    });

    it("cancel 返回 authorizationId，并使同 id 的 issue 与 request 被拒", () => {
      const { service, target } = buildCancelFixture();

      expect(service.cancelStrictClickAuthorization("auth-1"))
        .toEqual({ authorizationId: "auth-1" });

      expect(() => service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-1",
      })).toThrow(/authorization id was cancelled/);

      expect(() => service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      })).toThrow(/authorization id was cancelled/);

      // 其他 id 不受影响
      expect(service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-2",
      })).toMatchObject({ id: "auth-2" });
    });

    it("cancel 撤销已签发的 control-plane grant，之后 consume 失败", () => {
      const { service, authorizations, target, consumeInput } =
        buildCancelFixture();

      service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-1",
      });

      service.cancelStrictClickAuthorization("auth-1");

      expect(authorizations.consume({
        ...consumeInput,
        id: "auth-1",
      })).toEqual({ ok: false, reason: "missing" });
    });

    it("cancel 取消 pending approval，之后 approve 失败", () => {
      const { service, operatorApprovals, target } =
        buildCancelFixture();

      service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      });

      service.cancelStrictClickAuthorization("auth-1");

      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({ state: "cancelled" });
      expect(() => operatorApprovals.approve("approval-1"))
        .toThrow(/missing or no longer pending/);
    });

    it("cancel 撤销已批准未消费的 operator grant，并使 approval 变为 cancelled", () => {
      const {
        service,
        operatorApprovals,
        authorizations,
        target,
        consumeInput,
        setNow,
      } = buildCancelFixture();

      service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      });
      operatorApprovals.approve("approval-1");
      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({ state: "approved" });

      setNow(200);
      service.cancelStrictClickAuthorization("auth-1");

      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({
          state: "cancelled",
          authorizationId: "auth-1",
          resolvedAt: 200,
        });
      expect(authorizations.consume({
        ...consumeInput,
        id: "auth-1",
      })).toEqual({ ok: false, reason: "missing" });
    });

    it("已消费 grant 的 cancel 不抛错，approval 仍为 approved", () => {
      const {
        service,
        operatorApprovals,
        authorizations,
        target,
        consumeInput,
      } = buildCancelFixture();

      service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      });
      operatorApprovals.approve("approval-1");
      expect(authorizations.consume({
        ...consumeInput,
        id: "auth-1",
      }).ok).toBe(true);

      expect(() => service.cancelStrictClickAuthorization("auth-1"))
        .not.toThrow();
      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({ state: "approved" });
    });

    it("grant 已过期时 cancel 不翻转 approved", () => {
      const { service, operatorApprovals, target, setNow } =
        buildCancelFixture();

      service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      });
      operatorApprovals.approve("approval-1");

      // grant expiresAt = 1100
      setNow(1_100);
      service.cancelStrictClickAuthorization("auth-1");

      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({ state: "approved" });
    });

    it("clearTab 之后 cancel 为 no-op，不抛错", () => {
      const {
        service,
        authorizations,
        operatorApprovals,
        target,
      } = buildCancelFixture();

      service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      });
      service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-2",
      });

      authorizations.clearTab(7);
      operatorApprovals.clearTab(7);

      expect(() => service.cancelStrictClickAuthorization("auth-1"))
        .not.toThrow();
      expect(() => service.cancelStrictClickAuthorization("auth-2"))
        .not.toThrow();
      expect(() => service.cancelStrictClickAuthorization("never-seen"))
        .not.toThrow();

      // 已被 clearTab 失效的 approval 不被改写
      expect(service.operatorApprovalStatus("approval-1"))
        .toMatchObject({ state: "invalidated" });
    });

    it("没有配置 operatorApprovals 时 cancel 仍能撤销 grant 且不抛错", () => {
      const states = new TabStateStore();
      states.put(observation());
      const origins = new MutableExactOriginAllowlist();
      origins.replace(["https://fixture.test"]);
      const authorizations = new InMemoryAuthorizationStore({
        now: () => 100,
      });
      const service = new TrustedHostExecutionService(
        states,
        origins,
        new StrictClickAuthorizationIssuanceService(
          states,
          authorizations,
          origins,
        ),
        {} as never,
        {} as never,
      );

      service.issueStrictClickAuthorization({
        authorizationId: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        ttlMs: 1_000,
      });

      expect(service.cancelStrictClickAuthorization("auth-1"))
        .toEqual({ authorizationId: "auth-1" });
      expect(authorizations.consume({
        id: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "click",
        effectClass: "unknown",
      })).toEqual({ ok: false, reason: "missing" });
    });

    it("tombstone 达到上限后最旧 id 被驱逐，可再次 request", () => {
      const { service, target } = buildCancelFixture({
        maxCancelledAuthorizationIds: 2,
      });

      service.cancelStrictClickAuthorization("auth-1");
      service.cancelStrictClickAuthorization("auth-2");
      service.cancelStrictClickAuthorization("auth-3");

      // auth-1 被 FIFO 驱逐
      expect(service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-1",
      })).toMatchObject({ authorizationId: "auth-1" });

      // auth-2 / auth-3 仍被 tombstone
      expect(() => service.requestOperatorApproval({
        ...target,
        authorizationId: "auth-2",
      })).toThrow(/authorization id was cancelled/);
      expect(() => service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-3",
      })).toThrow(/authorization id was cancelled/);
    });

    it("重复 cancel 同一 id 会刷新其 tombstone 位置而不占用额外容量", () => {
      const { service, target } = buildCancelFixture({
        maxCancelledAuthorizationIds: 2,
      });

      service.cancelStrictClickAuthorization("auth-1");
      service.cancelStrictClickAuthorization("auth-2");
      // 刷新 auth-1：此时最旧的是 auth-2
      service.cancelStrictClickAuthorization("auth-1");
      service.cancelStrictClickAuthorization("auth-3");

      expect(() => service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-1",
      })).toThrow(/authorization id was cancelled/);
      expect(service.issueStrictClickAuthorization({
        ...target,
        authorizationId: "auth-2",
      })).toMatchObject({ id: "auth-2" });
    });

    it("maxCancelledAuthorizationIds 非正整数时构造失败", () => {
      expect(() => buildCancelFixture({
        maxCancelledAuthorizationIds: 0,
      })).toThrow(/maxCancelledAuthorizationIds/);
      expect(() => buildCancelFixture({
        maxCancelledAuthorizationIds: 1.5,
      })).toThrow(/maxCancelledAuthorizationIds/);
    });
  });
});
