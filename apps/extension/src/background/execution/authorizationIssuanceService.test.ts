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
  StrictClickAuthorizationIssuanceService,
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

function setup(
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
  const service =
    new StrictClickAuthorizationIssuanceService(
      states,
      authorizations,
      origins,
    );

  return {
    authorizations,
    origins,
    service,
  };
}

const input = {
  authorizationId: "auth-1",
  tabId: 7,
  observedRevision: "rev-1",
  ref: "@e_1",
  ttlMs: 1_000,
};

describe(
  "StrictClickAuthorizationIssuanceService",
  () => {
    it(
      "control-plane 只能满足 Agent-owned unknown click",
      () => {
        const owned = setup(true);

        expect(
          owned.service.issueControlPlane(input),
        ).toEqual({
          id: "auth-1",
          expiresAt: 1_100,
          origin: "https://fixture.test",
          assurance: "control-plane",
        });

        const existing = setup(false);
        expect(
          () =>
            existing.service.issueControlPlane(
              input,
            ),
        ).toThrow(
          /required assurance: operator-approved/,
        );
      },
    );

    it(
      "operator-approved 固定签发 trusted-ui provenance",
      () => {
        const {
          authorizations,
          service,
        } = setup(false);

        expect(
          service.issueOperatorApproved(input),
        ).toEqual({
          id: "auth-1",
          expiresAt: 1_100,
          origin: "https://fixture.test",
          assurance: "operator-approved",
        });

        const consumed =
          authorizations.consume({
            id: "auth-1",
            tabId: 7,
            observedRevision: "rev-1",
            ref: "@e_1",
            actionKind: "click",
            effectClass: "unknown",
            minimumAssurance:
              "operator-approved",
          });

        expect(consumed.ok).toBe(true);
        if (!consumed.ok) {
          throw new Error(
            "grant not consumable",
          );
        }
        expect(
          consumed.grant.source,
        ).toBe("trusted-ui");
      },
    );

    it(
      "enterprise-policy 固定签发 enterprise-policy provenance",
      () => {
        const {
          authorizations,
          service,
        } = setup(false);

        expect(
          service.issueEnterprisePolicy(input),
        ).toEqual({
          id: "auth-1",
          expiresAt: 1_100,
          origin: "https://fixture.test",
          assurance: "enterprise-policy",
        });

        const consumed =
          authorizations.consume({
            id: "auth-1",
            tabId: 7,
            observedRevision: "rev-1",
            ref: "@e_1",
            actionKind: "click",
            effectClass: "unknown",
            minimumAssurance:
              "operator-approved",
          });

        expect(consumed.ok).toBe(true);
        if (!consumed.ok) {
          throw new Error(
            "grant not consumable",
          );
        }
        expect(
          consumed.grant.source,
        ).toBe("enterprise-policy");
      },
    );

    it(
      "所有来源共享 retained target、origin 与 TTL fail-closed 校验",
      () => {
        const blocked = setup(false);
        blocked.origins.clear();

        expect(
          () =>
            blocked.service
              .issueOperatorApproved(input),
        ).toThrow(
          /outside the auto-act allowlist/,
        );

        const valid = setup(false);

        expect(
          () =>
            valid.service
              .issueOperatorApproved({
                ...input,
                ref: "@missing",
              }),
        ).toThrow(
          /outside the retained observation/,
        );

        expect(
          () =>
            valid.service
              .issueEnterprisePolicy({
                ...input,
                ttlMs: 60_001,
              }),
        ).toThrow(
          /ttl is outside the allowed range/,
        );
      },
    );
  },
);
