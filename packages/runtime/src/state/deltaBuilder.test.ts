import { describe, expect, it } from "vitest";
import type { BrowserObservation, ElementState } from "@browser-agent-next/core";
import { buildObservationDelta } from "./deltaBuilder.js";

function button(ref: string, name: string): ElementState {
  return {
    ref,
    kind: "element",
    semantic: { role: "button", name },
    state: { visible: true, enabled: true, focused: false },
    frameId: "main",
    capabilities: [{ kind: "click" }],
    provenance: { ax: true },
  };
}

function observation(revision: string, elements: ElementState[]): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 1,
      title: "Example",
      url: "https://example.test/",
      origin: "https://example.test",
      ownedBySession: true,
    },
    revision: {
      id: revision,
      stateEpoch: "state-a",
      documentEpoch: "doc-a",
      sequence: Number(revision.replace("r", "")),
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: elements.length, totalKnown: elements.length },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: true },
    },
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1280,
      scrollHeight: 720,
    },
    frames: [{ frameId: "main", documentEpoch: "doc-a", accessible: true }],
    elements,
  };
}

describe("buildObservationDelta", () => {
  it("returns unchanged when normalized state is the same", () => {
    const result = buildObservationDelta(
      observation("r1", [button("@e_1", "Continue")]),
      observation("r2", [button("@e_1", "Continue")]),
    );

    expect(result.kind).toBe("unchanged");
    if (result.kind !== "unchanged") throw new Error("unexpected result");
    expect(result.delta.changes).toEqual([]);
  });

  it("produces keyed updates by persistent ref on a small page", () => {
    const result = buildObservationDelta(
      observation("r1", [button("@e_1", "Continue")]),
      observation("r2", [button("@e_1", "Proceed")]),
    );

    expect(result.kind).toBe("delta");
    if (result.kind !== "delta") throw new Error("unexpected result");
    expect(result.delta.changes).toHaveLength(1);
    expect(result.delta.changes[0]).toMatchObject({
      type: "update",
      ref: "@e_1",
      patch: { semantic: { role: "button", name: "Proceed" } },
    });
  });

  it("represents add and remove without positional matching", () => {
    const result = buildObservationDelta(
      observation("r1", [button("@e_1", "A")]),
      observation("r2", [button("@e_2", "B")]),
    );

    expect(result.kind).toBe("delta");
    if (result.kind !== "delta") throw new Error("unexpected result");
    expect(result.delta.changes.map((change) => change.type).sort()).toEqual(["add", "remove"]);
  });

  it("falls back to full state across document epochs", () => {
    const previous = observation("r1", [button("@e_1", "A")]);
    const next = observation("r2", [button("@e_1", "A")]);
    next.revision.documentEpoch = "doc-b";
    next.frames[0] = { frameId: "main", documentEpoch: "doc-b", accessible: true };

    expect(buildObservationDelta(previous, next)).toEqual({
      kind: "full",
      reason: "document-epoch-changed",
    });
  });

  it("uses ratio protection on sufficiently large observations", () => {
    const before = Array.from({ length: 20 }, (_, index) => button("@e_" + index, "A" + index));
    const after = before.map((element, index) =>
      index < 13 ? button(element.ref, "Changed" + index) : element,
    );

    expect(
      buildObservationDelta(
        observation("r1", before),
        observation("r2", after),
        { maxChangeRatio: 0.6 },
      ),
    ).toEqual({ kind: "full", reason: "delta-too-large" });
  });
});
