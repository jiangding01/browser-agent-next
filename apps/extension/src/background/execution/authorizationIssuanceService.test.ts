import { describe, expect, it } from "vitest";
import type {
  BrowserObservation,
  StrictActionArgs,
  StrictKey,
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
  assertStrictActionTarget,
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

describe("StrictClickAuthorizationIssuanceService 写入类动作", () => {
  function fieldSetup(fieldState: Record<string, unknown> = {}) {
    const states = new TabStateStore();
    const base = observation(true);
    states.put({
      ...base,
      elements: [{
        ref: "@e_1",
        kind: "field",
        semantic: { role: "textbox", name: "Name" },
        state: { visible: true, enabled: true, focused: false, ...fieldState },
        frameId: "web:0",
        capabilities: [{ kind: "setValue", valueType: "text" }, { kind: "focus" }],
        provenance: { dom: true, ax: true },
      }],
    });
    const authorizations = new InMemoryAuthorizationStore({ now: () => 100 });
    const origins = new MutableExactOriginAllowlist();
    origins.replace(["https://fixture.test"]);
    return {
      authorizations,
      service: new StrictClickAuthorizationIssuanceService(states, authorizations, origins),
    };
  }

  const setValue = { kind: "setValue" as const, value: "张三" };

  it("签发的 grant 绑定 setValue 与参数，只能按同一参数消费", () => {
    const { service, authorizations } = fieldSetup();
    service.issueControlPlane({ ...input, action: setValue });

    const consume = (actionArgs: string) =>
      authorizations.consume({
        id: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "setValue",
        actionArgs,
        effectClass: "unknown",
      });

    expect(consume(JSON.stringify({ kind: "setValue", value: "李四" }))).toMatchObject({
      ok: false,
      reason: "binding-mismatch",
    });
    expect(consume(JSON.stringify(setValue))).toMatchObject({ ok: true });
  });

  it("敏感字段在签发前被拒绝且不产生 grant", () => {
    const { service, authorizations } = fieldSetup({ sensitive: true });
    expect(() => service.issueControlPlane({ ...input, action: setValue })).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" }),
    );
    expect(authorizations.size()).toBe(0);
  });

  it("enterprise-policy 只签发 click", () => {
    const { service, authorizations } = fieldSetup();
    expect(() => service.issueEnterprisePolicy({ ...input, action: setValue })).toThrow(
      expect.objectContaining({ code: "AUTHORIZATION_REQUIRED" }),
    );
    expect(authorizations.size()).toBe(0);
  });

  it("click 签发不受写入类检查影响", () => {
    const { service } = setup(true);
    expect(service.issueControlPlane({ ...input, action: { kind: "click" } })).toMatchObject({
      id: "auth-1",
    });
  });
});

describe("assertStrictActionTarget（S2 签发前的早期拒绝）", () => {
  type Element = BrowserObservation["elements"][number];

  function element(overrides: {
    role?: string;
    state?: Partial<Element["state"]>;
    capabilities?: Element["capabilities"];
    dom?: boolean;
  } = {}): Element {
    return {
      ref: "@e_1",
      kind: "field",
      semantic: { role: overrides.role ?? "textbox", name: "Field" },
      state: { visible: true, enabled: true, focused: false, ...overrides.state },
      frameId: "web:0",
      capabilities: overrides.capabilities ?? [{ kind: "focus" }],
      provenance: { dom: overrides.dom ?? true, ax: true },
    };
  }

  const selectable: Element["capabilities"] = [
    { kind: "selectOption", optionsKnown: true },
    { kind: "focus" },
  ];
  const submittable: Element["capabilities"] = [
    { kind: "setValue", valueType: "text" },
    { kind: "submit" },
    { kind: "focus" },
  ];

  function code(target: Element, action: StrictActionArgs): string {
    try {
      assertStrictActionTarget(target, action);
      return "ok";
    } catch (error) {
      return (error as { code: string }).code;
    }
  }

  const selectOption = { kind: "selectOption", label: "上海" } as const;
  const submit = { kind: "submit" } as const;
  const press = (key: StrictKey) => ({ kind: "pressKey", key }) as const;

  it("selectOption：需要 selectOption capability，拒绝敏感、禁用与非 DOM 来源", () => {
    expect(code(element({ role: "combobox", capabilities: selectable }), selectOption)).toBe("ok");
    expect(code(element({ role: "combobox" }), selectOption)).toBe("TARGET_CAPABILITY_MISSING");
    expect(
      code(element({ role: "combobox", capabilities: selectable, state: { sensitive: true } }), selectOption),
    ).toBe("POLICY_BLOCKED");
    expect(
      code(element({ role: "combobox", capabilities: selectable, state: { enabled: false } }), selectOption),
    ).toBe("ACTION_NOT_SUPPORTED");
    expect(code(element({ role: "combobox", capabilities: selectable, dom: false }), selectOption)).toBe(
      "ACTION_NOT_SUPPORTED",
    );
  });

  it("submit：需要 submit capability，拒绝禁用与非 DOM 来源", () => {
    expect(code(element({ capabilities: submittable }), submit)).toBe("ok");
    expect(code(element({ capabilities: [{ kind: "setValue", valueType: "text" }] }), submit)).toBe(
      "TARGET_CAPABILITY_MISSING",
    );
    expect(code(element({ capabilities: submittable, state: { enabled: false } }), submit)).toBe(
      "ACTION_NOT_SUPPORTED",
    );
    expect(code(element({ capabilities: submittable, dom: false }), submit)).toBe("ACTION_NOT_SUPPORTED");
  });

  it("pressKey：拒绝敏感、禁用与非 DOM 来源", () => {
    expect(code(element(), press("Tab"))).toBe("ok");
    expect(code(element({ state: { sensitive: true } }), press("Tab"))).toBe("POLICY_BLOCKED");
    expect(code(element({ state: { enabled: false } }), press("Tab"))).toBe("ACTION_NOT_SUPPORTED");
    expect(code(element({ dom: false }), press("Tab"))).toBe("ACTION_NOT_SUPPORTED");
  });

  it("pressKey：方向键不得作用于值控件，Escape 不得作用于搜索框", () => {
    for (const key of ["ArrowUp", "ArrowDown"] as const) {
      for (const role of ["spinbutton", "slider", "radio"]) {
        expect(code(element({ role }), press(key)), key + " " + role).toBe("ACTION_NOT_SUPPORTED");
      }
      // 对照：方向键可以作用于文本框与自定义 listbox / combobox。observation 无法区分原生 select
      // 与 ARIA combobox（两者都有 selectOption capability），原生 select 由执行时的调用 A 拒绝。
      expect(code(element(), press(key)), key).toBe("ok");
      expect(code(element({ role: "listbox", capabilities: selectable }), press(key)), key).toBe("ok");
      expect(code(element({ role: "combobox", capabilities: selectable }), press(key)), key).toBe("ok");
    }
    expect(code(element({ role: "searchbox" }), press("Escape"))).toBe("ACTION_NOT_SUPPORTED");
    expect(code(element({ role: "textbox" }), press("Escape"))).toBe("ok");
    // Tab 只移动焦点，不受值控件限制。
    expect(code(element({ role: "searchbox" }), press("Tab"))).toBe("ok");
    expect(code(element({ role: "combobox", capabilities: selectable }), press("Tab"))).toBe("ok");
    expect(code(element({ role: "slider" }), press("Escape"))).toBe("ok");
  });

  it("click 与 setValue 不受 S2 检查影响", () => {
    expect(code(element({ role: "radio", state: { sensitive: true }, dom: false }), { kind: "click" })).toBe("ok");
    expect(
      code(element({ capabilities: [{ kind: "setValue", valueType: "text" }] }), { kind: "setValue", value: "x" }),
    ).toBe("ok");
  });
});

describe("StrictClickAuthorizationIssuanceService S2 动作", () => {
  function selectSetup() {
    const states = new TabStateStore();
    states.put({
      ...observation(true),
      elements: [{
        ref: "@e_1",
        kind: "field",
        semantic: { role: "combobox", name: "City" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "selectOption", optionsKnown: true }, { kind: "focus" }],
        provenance: { dom: true, ax: true },
      }],
    });
    const authorizations = new InMemoryAuthorizationStore({ now: () => 100 });
    const origins = new MutableExactOriginAllowlist();
    origins.replace(["https://fixture.test"]);
    return {
      authorizations,
      service: new StrictClickAuthorizationIssuanceService(states, authorizations, origins),
    };
  }

  it("grant 的 actionKind 取参数的 kind，并绑定 label", () => {
    const { service, authorizations } = selectSetup();
    service.issueControlPlane({ ...input, action: { kind: "selectOption", label: "上海" } });

    const consume = (actionKind: string, actionArgs: string) =>
      authorizations.consume({
        id: "auth-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: actionKind as "selectOption",
        actionArgs,
        effectClass: "unknown",
      });

    expect(consume("selectOption", JSON.stringify({ kind: "selectOption", label: "北京" }))).toMatchObject({
      ok: false,
      reason: "binding-mismatch",
    });
    expect(consume("pressKey", JSON.stringify({ kind: "pressKey", key: "Tab" }))).toMatchObject({ ok: false });
    expect(consume("selectOption", JSON.stringify({ kind: "selectOption", label: "上海" }))).toMatchObject({
      ok: true,
    });
  });

  it("早期拒绝发生在签发之前，不产生 grant", () => {
    const { service, authorizations } = selectSetup();
    expect(() => service.issueControlPlane({ ...input, action: { kind: "submit" } })).toThrow(
      expect.objectContaining({ code: "TARGET_CAPABILITY_MISSING" }),
    );
    expect(authorizations.size()).toBe(0);
    // 对照：同一目标上合法的动作照常签发。
    service.issueOperatorApproved({ ...input, action: { kind: "pressKey", key: "Tab" } });
    expect(authorizations.size()).toBe(1);
  });

});
