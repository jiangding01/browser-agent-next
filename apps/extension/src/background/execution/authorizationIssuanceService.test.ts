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

function observation(
  ownedBySession: boolean,
): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://fixture.test/",
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
      ref: "@e_1",
      kind: "element",
      semantic: {
        role: "button",
        name: "Save",
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

function createService(
  ownedBySession: boolean,
) {
  const states = new TabStateStore();
  states.put(observation(ownedBySession));

  const authorizations =
    new InMemoryAuthorizationStore({
      now: () => 100,
    });
  const origins =
    new MutableExactOriginAllowlist();
  origins.replace(["https://fixture.test"]);

  return {
    authorizations,
    service: new AuthorizationIssuanceService(
      states,
      authorizations,
      origins,
    ),
  };
}

const input = {
  authorizationId: "auth-1",
  tabId: 7,
  observedRevision: "rev-1",
  ref: "@e_1",
  ttlMs: 1_000,
};

describe("AuthorizationIssuanceService", () => {
  it("control-plane 只能覆盖 Agent-owned unknown click", () => {
    const { service } = createService(true);

    expect(
      service.issueControlPlaneStrictClick(input),
    ).toEqual({
      id: "auth-1",
      expiresAt: 1_100,
      origin: "https://fixture.test",
      assurance: "control-plane",
    });
  });

  it("用户已有 Tab 的 unknown click 需要 operator-approved 或更高 assurance", () => {
    const { service } = createService(false);

    expect(() =>
      service.issueControlPlaneStrictClick(input),
    ).toThrow(/required assurance: operator-approved/);

    expect(
      service.issueOperatorApprovedStrictClick(input),
    ).toMatchObject({
      assurance: "operator-approved",
    });
  });

  it("enterprise-policy 可以满足 operator-approved 最低门槛但保留自身标签", () => {
    const { service } = createService(false);

    expect(
      service.issueEnterprisePolicyStrictClick(input),
    ).toMatchObject({
      assurance: "enterprise-policy",
    });
  });

  it("专用签发 API 不向 ingress 暴露 source/assurance 参数", () => {
    const { service } = createService(false);

    expect(
      service.issueOperatorApprovedStrictClick.length,
    ).toBe(1);
    expect(
      service.issueEnterprisePolicyStrictClick.length,
    ).toBe(1);
  });

  it("TTL、retained revision/ref 与 auto-act origin 仍由共享核心统一校验", () => {
    const states = new TabStateStore();
    states.put(observation(true));

    const service =
      new AuthorizationIssuanceService(
        states,
        new InMemoryAuthorizationStore(),
        new MutableExactOriginAllowlist(),
        { maxAuthorizationTtlMs: 500 },
      );

    expect(() =>
      service.issueControlPlaneStrictClick({
        ...input,
        ttlMs: 501,
      }),
    ).toThrow(/ttl is outside/);

    expect(() =>
      service.issueControlPlaneStrictClick(input),
    ).toThrow(/outside the auto-act allowlist/);
  });
});
