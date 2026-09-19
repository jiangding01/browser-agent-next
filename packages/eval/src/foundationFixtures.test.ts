import { describe, expect, it } from "vitest";
import { isActionSpaceComplete } from "@browser-agent-next/core";
import {
  buildObservationDelta,
  evaluateStrictPreflight,
} from "@browser-agent-next/runtime";
import { foundationFixtures } from "./foundationFixtures.js";

describe("foundation regression fixtures", () => {
  it("represents a stable identity semantic update as an update delta", () => {
    const { before, after } = foundationFixtures.stableSemanticUpdate;
    const result = buildObservationDelta(before, after);

    expect(result.kind).toBe("delta");
    if (result.kind !== "delta") throw new Error("unexpected result");

    expect(result.delta.changes).toEqual([
      expect.objectContaining({
        type: "update",
        ref: "@e_1",
      }),
    ]);
  });

  it("represents a same-looking replacement as remove + add, never as rebind", () => {
    const { before, after } = foundationFixtures.sameLookingReplacement;
    const result = buildObservationDelta(before, after);

    expect(result.kind).toBe("delta");
    if (result.kind !== "delta") throw new Error("unexpected result");

    expect(result.delta.changes.map((change) => change.type).sort()).toEqual([
      "add",
      "remove",
    ]);

    const expected = before.elements[0]!;
    expect(evaluateStrictPreflight({
      expected,
      live: {
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true },
        geometry: { inViewport: true, hitTestable: true },
      },
      actionKind: "click",
      documentCompatible: true,
      identityMatches: false,
    })).toMatchObject({
      ok: false,
      code: "TARGET_IDENTITY_MISMATCH",
    });
  });

  it("falls back to full observation across document replacement", () => {
    const { before, after } = foundationFixtures.documentReplacement;

    expect(buildObservationDelta(before, after)).toEqual({
      kind: "full",
      reason: "document-epoch-changed",
    });
  });

  it("keeps incomplete actionable coverage explicit", () => {
    expect(isActionSpaceComplete(foundationFixtures.truncatedActionSpace)).toBe(false);
    expect(foundationFixtures.truncatedActionSpace.coverage.actionable).toMatchObject({
      status: "truncated",
      returned: 2,
      totalKnown: 120,
    });
  });

  it("includes a mixed CJK/Latin fixture for future decision evaluation", () => {
    expect(
      foundationFixtures.mixedLanguage.elements.map((element) => element.semantic.name),
    ).toEqual(["创建工单", "Open details", "提交 Submit"]);
  });
});
