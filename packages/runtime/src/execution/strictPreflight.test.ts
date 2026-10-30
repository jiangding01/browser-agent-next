import { describe, expect, it } from "vitest";
import type { ElementState } from "@browser-agent-next/core";
import { evaluateStrictPreflight } from "./strictPreflight.js";

function observedButton(name = "Save"): ElementState {
  return {
    ref: "@e_1",
    kind: "element",
    semantic: { role: "button", name },
    state: {
      visible: true,
      enabled: true,
      focused: false,
    },
    geometry: {
      rect: { x: 10, y: 10, width: 100, height: 32 },
      inViewport: true,
      hitTestable: true,
    },
    frameId: "main",
    capabilities: [{ kind: "click" }],
    provenance: { ax: true, dom: true },
  };
}

function liveButton(name = "Save") {
  return {
    semantic: { role: "button", name },
    state: { visible: true, enabled: true },
    geometry: { inViewport: true, hitTestable: true },
  };
}

describe("evaluateStrictPreflight", () => {
  it("allows the same live target despite unrelated page revisions", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton(),
      live: liveButton(),
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toEqual({ ok: true });
  });

  it("rejects a same-looking replacement node when identity changed", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton(),
      live: liveButton(),
      actionKind: "click",
      documentCompatible: true,
      identityMatches: false,
    })).toMatchObject({
      ok: false,
      code: "TARGET_IDENTITY_MISMATCH",
    });
  });

  it("rejects a live semantic name change", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton("Delete A"),
      live: liveButton("Delete B"),
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toMatchObject({
      ok: false,
      code: "TARGET_SEMANTIC_CHANGED",
    });
  });

  it("normalizes harmless whitespace and Unicode form in accessible names", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton("Ｓａｖｅ   now"),
      live: liveButton("Save now"),
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toEqual({ ok: true });
  });

  it("rejects clicks that were not observed as clickable", () => {
    const expected = observedButton();
    expected.capabilities = [];

    expect(evaluateStrictPreflight({
      expected,
      live: liveButton(),
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toMatchObject({
      ok: false,
      code: "TARGET_CAPABILITY_MISSING",
    });
  });

  it("requires click geometry and hit-testability", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton(),
      live: {
        ...liveButton(),
        geometry: { inViewport: true, hitTestable: false },
      },
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toMatchObject({
      ok: false,
      code: "TARGET_OCCLUDED",
    });

    expect(evaluateStrictPreflight({
      expected: observedButton(),
      live: {
        ...liveButton(),
        geometry: { inViewport: false, hitTestable: true },
      },
      actionKind: "click",
      documentCompatible: true,
      identityMatches: true,
    })).toMatchObject({
      ok: false,
      code: "TARGET_OUT_OF_VIEWPORT",
    });
  });

  it("applies the same geometry requirements to setValue and checks its capability", () => {
    const field: ElementState = {
      ...observedButton("Name"),
      kind: "field",
      semantic: { role: "textbox", name: "Name" },
      capabilities: [{ kind: "setValue", valueType: "text" }],
    };
    const live = {
      semantic: { role: "textbox", name: "Name" },
      state: { visible: true, enabled: true },
      geometry: { inViewport: true, hitTestable: true },
    };
    const run = (overrides: Partial<typeof live>, expected = field) =>
      evaluateStrictPreflight({
        expected,
        live: { ...live, ...overrides },
        actionKind: "setValue",
        documentCompatible: true,
        identityMatches: true,
      });

    expect(run({})).toEqual({ ok: true });
    expect(run({ geometry: { inViewport: true, hitTestable: false } })).toMatchObject({
      ok: false,
      code: "TARGET_OCCLUDED",
    });
    expect(run({ geometry: { inViewport: false, hitTestable: true } })).toMatchObject({
      ok: false,
      code: "TARGET_OUT_OF_VIEWPORT",
    });
    expect(run({}, { ...field, capabilities: [{ kind: "focus" }] })).toMatchObject({
      ok: false,
      code: "TARGET_CAPABILITY_MISSING",
    });
  });

  it("rejects document replacement even when identity-like metadata looks unchanged", () => {
    expect(evaluateStrictPreflight({
      expected: observedButton(),
      live: liveButton(),
      actionKind: "click",
      documentCompatible: false,
      identityMatches: true,
    })).toMatchObject({
      ok: false,
      code: "DOCUMENT_CHANGED",
    });
  });
});
