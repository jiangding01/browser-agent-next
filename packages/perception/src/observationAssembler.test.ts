import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import { createObservationAssembler } from "./observationAssembler.js";
import type {
  ObservationAssemblyInput,
  PerceptionElementCandidate,
  PerceptionSourceResult,
} from "./types.js";

function candidate(
  source: "ax" | "dom",
  name: string,
  mergeKey?: string,
  kind: "element" | "field" = "element",
): PerceptionElementCandidate {
  if (source === "dom") {
    return {
      source,
      identity: {
        source: "dom",
        tabId: 1,
        frameEpoch: "frame-a",
        stableId: "s-" + name + "-" + kind,
      },
      ...(mergeKey ? { mergeKey } : {}),
      kind,
      semantic: {
        role: kind === "field" ? "textbox" : "button",
        name,
        text: "DOM " + name,
      },
      state: { visible: true, enabled: true, focused: false },
      geometry: {
        rect: { x: 10, y: 10, width: 80, height: 30 },
        inViewport: true,
        hitTestable: true,
      },
      frameId: "main",
      capabilities:
        kind === "field"
          ? [{ kind: "setValue", valueType: "text" }]
          : [{ kind: "click" }],
    };
  }

  return {
    source,
    identity: {
      source: "ax",
      tabId: 1,
      cdpFrameId: "main",
      documentEpoch: "doc-a",
      backendNodeId: name === "Save" ? 42 : 99,
    },
    ...(mergeKey ? { mergeKey } : {}),
    kind,
    semantic: {
      role: kind === "field" ? "textbox" : "button",
      name: "AX " + name,
    },
    state: { visible: true, enabled: true, focused: false },
    frameId: "main",
    capabilities:
      kind === "field"
        ? [{ kind: "setValue", valueType: "text" }]
        : [{ kind: "click" }],
  };
}

function source(
  kind: "ax" | "dom",
  elements: PerceptionElementCandidate[],
  status: "complete" | "partial" = "complete",
): PerceptionSourceResult {
  const fieldCount = elements.filter(
    (element) => element.kind === "field",
  ).length;

  return {
    source: kind,
    coverage: {
      actionable: {
        status,
        returned: elements.length,
        ...(status === "complete" ? { totalKnown: elements.length } : {}),
      },
      forms: {
        status,
        returned: fieldCount,
        ...(status === "complete" ? { totalKnown: fieldCount } : {}),
      },
      text: { status: "complete", returned: 0, totalKnown: 0 },
    },
    elements,
  };
}

function input(
  sources: PerceptionSourceResult[],
): ObservationAssemblyInput {
  return {
    tab: {
      tabId: 1,
      title: "Fixture",
      url: "https://fixture.test/",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    revision: {
      id: "state-a:1",
      stateEpoch: "state-a",
      documentEpoch: "doc-a",
      sequence: 1,
    },
    scope: { kind: "page" },
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1280,
      scrollHeight: 720,
    },
    frames: [{ frameId: "main", documentEpoch: "doc-a", accessible: true }],
    expectedSources: ["ax", "dom"],
    sources,
    shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
    canvas: { present: false, semanticallyCovered: true },
  };
}

describe("ObservationAssembler", () => {
  it("merges AX and DOM only through an explicit strong correspondence key", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);
    const mergeKey = "backend:main:doc-a:42";

    const observation = assembler.assemble(
      input([
        source("ax", [candidate("ax", "Save", mergeKey)]),
        source("dom", [candidate("dom", "Save", mergeKey)]),
      ]),
    );

    expect(observation.elements).toHaveLength(1);
    expect(observation.elements[0]).toMatchObject({
      semantic: {
        role: "button",
        name: "AX Save",
        text: "DOM Save",
      },
      provenance: { ax: true, dom: true },
    });
    expect(refs.byRef(observation.elements[0]!.ref)?.aliases).toHaveLength(1);
  });

  it("does not merge same-looking elements without strong correspondence evidence", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);

    const observation = assembler.assemble(
      input([
        source("ax", [candidate("ax", "Save")]),
        source("dom", [candidate("dom", "Save")]),
      ]),
    );

    expect(observation.elements).toHaveLength(2);
    expect(observation.elements[0]!.ref).not.toBe(observation.elements[1]!.ref);
  });

  it("reports canonical field count instead of hard-coding forms coverage to zero", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);
    const mergeKey = "backend:main:doc-a:99";

    const observation = assembler.assemble(
      input([
        source("ax", [candidate("ax", "Email", mergeKey, "field")]),
        source("dom", [candidate("dom", "Email", mergeKey, "field")]),
      ]),
    );

    expect(observation.elements).toHaveLength(1);
    expect(observation.coverage.forms).toEqual({
      status: "complete",
      returned: 1,
      totalKnown: 1,
    });
    expect(observation.coverage.actionable.returned).toBe(1);
  });

  it("degrades overall coverage when an expected source is partial", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);

    const observation = assembler.assemble(
      input([
        source("ax", [candidate("ax", "Save")]),
        source("dom", [candidate("dom", "Other")], "partial"),
      ]),
    );

    expect(observation.coverage.actionable).toMatchObject({
      status: "partial",
      returned: 2,
    });
  });

  it("does not pretend completeness when an expected source is omitted", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);

    const observation = assembler.assemble(
      input([source("ax", [candidate("ax", "Save")])]),
    );

    expect(observation.coverage.actionable).toMatchObject({
      status: "unknown",
    });
    expect(observation.warnings).toContain(
      "expected perception source missing: dom",
    );
  });
});
