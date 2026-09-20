import { describe, expect, it } from "vitest";
import type {
  BrowserObservation,
} from "@browser-agent-next/core";
import {
  InMemoryAuthorizationStore,
  MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import {
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  AuthorizationIssuanceService,
} from "./authorizationIssuanceService.js";
import {
  OperatorApprovalService,
} from "./operatorApprovalService.js";

function observation(
  ownedBySession = false,
): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Checkout",
      url: "https://fixture.test/checkout",
      origin: "https://fixture.test",
      ownedBySession,
    },
    revision: {
      id: "rev-1",
      stateEpoch: "runtime",
      documentEpoch: "doc",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      forms: {
        status: "complete",
        returned: 0,
        totalKnown: 0,
      },
      text: { status: "unknown", returned: 0 },
      frames: {
        discovered: 1,
        accessible: 1,
        degraded: [],
      },
      shadowDom: {
        openRootsCovered: true,
        closedRootsUnknown: true,
      },
      canvas: {
        present: false,
        semanticallyCovered: false,
      },
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
      ref: "@pay",
      kind: "element",
      semantic: {
        role: "button",
        name: "Pay now",
        description: "Submit payment",
      },
      state: {
        visible: true,
        enabled: true,
        focused: false,
      },
      frameId: "web:0",
      capabilities: [{ kind: "click" }],
      provenance: { dom: true, ax: true },
    }],
  };
}

function fixture(
  options: {
    now?: () => number;
    requestId?: () => string;
    approvalTtlMs?: number;
    resultRetentionMs?: number;
  } = {},
) {
  const now = options.now ?? (() => 100);

  const states = new TabStateStore();
  states.put(observation());

  const authorizations =
    new InMemoryAuthorizationStore({
      now,
    });
  const origins =
    new MutableExactOriginAllowlist();
  origins.replace(["https://fixture.test"]);

  const issuance =
    new AuthorizationIssuanceService(
      states,
      authorizations,
      origins,
    );

  return {
    states,
    authorizations,
    service: new OperatorApprovalService(
      states,
      issuance,
      {
        requestId:
          options.requestId ??
          (() => "approval-1"),
        now,
        ...(options.approvalTtlMs !== undefined
          ? {
              approvalTtlMs:
                options.approvalTtlMs,
            }
          : {}),
        ...(options.resultRetentionMs !== undefined
          ? {
              resultRetentionMs:
                options.resultRetentionMs,
            }
          : {}),
      },
    ),
  };
}

const request = {
  authorizationId: "auth-op-1",
  tabId: 7,
  observedRevision: "rev-1",
  ref: "@pay",
  ttlMs: 1_000,
};

describe("OperatorApprovalService", () => {
  it("pending view 只暴露审批所需目标摘要，不包含 value", () => {
    const { service } = fixture();

    expect(
      service.requestStrictClickApproval(request),
    ).toEqual({
      approvalRequestId: "approval-1",
      status: "pending",
      createdAt: 100,
      expiresAt: 60_100,
      tab: {
        tabId: 7,
        title: "Checkout",
        url: "https://fixture.test/checkout",
        origin: "https://fixture.test",
        ownedBySession: false,
      },
      target: {
        ref: "@pay",
        role: "button",
        name: "Pay now",
        description: "Submit payment",
      },
    });
  });

  it("approve 固定签发 operator-approved grant，且不能重复决策", () => {
    const { service, authorizations } =
      fixture();

    service.requestStrictClickApproval(request);
    const result = service.approve(
      "approval-1",
    );

    expect(result).toMatchObject({
      status: "approved",
      authorizationId: "auth-op-1",
      grant: {
        id: "auth-op-1",
        assurance: "operator-approved",
      },
    });

    expect(
      authorizations.consume({
        id: "auth-op-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@pay",
        actionKind: "click",
        effectClass: "unknown",
        minimumAssurance:
          "operator-approved",
      }),
    ).toMatchObject({
      ok: true,
      grant: {
        source: "trusted-ui",
        assurance: "operator-approved",
      },
    });

    expect(() =>
      service.approve("approval-1"),
    ).toThrow(/not pending: approved/);
  });

  it("deny 不签发 grant", () => {
    const { service, authorizations } =
      fixture();

    service.requestStrictClickApproval(request);
    expect(
      service.deny("approval-1"),
    ).toMatchObject({
      status: "denied",
    });

    expect(
      authorizations.consume({
        id: "auth-op-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@pay",
        actionKind: "click",
        effectClass: "unknown",
      }),
    ).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("过期 pending request 不能再批准", () => {
    let now = 100;
    const { service } = fixture({
      now: () => now,
      approvalTtlMs: 50,
      resultRetentionMs: 100,
    });

    service.requestStrictClickApproval(request);
    now = 151;

    expect(
      service.getStatus("approval-1"),
    ).toMatchObject({
      status: "expired",
    });
    expect(() =>
      service.approve("approval-1"),
    ).toThrow(/not pending: expired/);
  });

  it("同一 authorizationId 不能并存多个 pending approval", () => {
    let id = 0;
    const { service } = fixture({
      requestId: () =>
        "approval-" + (++id),
    });

    service.requestStrictClickApproval(request);
    expect(() =>
      service.requestStrictClickApproval(
        request,
      ),
    ).toThrow(/already pending/);
  });

  it("tab 生命周期变化会取消 pending approval", () => {
    const { service } = fixture();

    service.requestStrictClickApproval(request);
    service.clearTab(7);

    expect(
      service.getStatus("approval-1"),
    ).toMatchObject({
      status: "cancelled",
    });
    expect(() =>
      service.approve("approval-1"),
    ).toThrow(/not pending: cancelled/);
  });

  it("申请时 retained revision/ref 必须仍可证明", () => {
    const { service, states } = fixture();
    states.clearTab(7);

    expect(() =>
      service.requestStrictClickApproval(
        request,
      ),
    ).toThrow(/observation.*no longer retained/);
  });
});
