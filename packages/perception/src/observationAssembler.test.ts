import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import { createObservationAssembler } from "./observationAssembler.js";
import type {
  ObservationAssemblyInput,
  PerceptionElementCandidate,
  PerceptionSourceResult,
} from "./types.js";

const complete = {
  status: "complete" as const,
  returned: 1,
  totalKnown: 1,
};

function candidate(
  source: "ax" | "dom",
  name: string,
  mergeKey?: string,
): PerceptionElementCandidate {
  if (source === "dom") {
    return {
      source,
      identity: {
        source: "dom",
        tabId: 1,
        frameEpoch: "frame-a",
        stableId: name === "Save" ? "s-save" : "s-" + name,
      },
      ...(mergeKey ? { mergeKey } : {}),
      kind: "element",
      semantic: { role: "button", name, text: "DOM " + name },
      state: { visible: true, enabled: true, focused: false },
      geometry: {
        rect: { x: 10, y: 10, width: 80, height: 30 },
        inViewport: true,
        hitTestable: true,
      },
      frameId: "main",
      capabilities: [{ kind: "click" }],
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
    kind: "element",
    semantic: { role: "button", name: "AX " + name },
    state: { visible: true, enabled: true, focused: false },
    frameId: "main",
    capabilities: [{ kind: "click" }],
  };
}

function source(
  kind: "ax" | "dom",
  elements: PerceptionElementCandidate[],
  status: "complete" | "partial" = "complete",
): PerceptionSourceResult {
  return {
    source: kind,
    coverage: {
      actionable: {
        status,
        returned: elements.length,
        ...(status === "complete" ? { totalKnown: elements.length } : {}),
      },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "complete", returned: 0, totalKnown: 0 },
    },
    elements,
  };
}

function input(sources: PerceptionSourceResult[]): ObservationAssemblyInput {
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
      geometry: {
        inViewport: true,
        hitTestable: true,
      },
      provenance: {
        ax: true,
        dom: true,
      },
    });

    const record = refs.byRef(observation.elements[0]!.ref);
    expect(record?.aliases).toHaveLength(1);
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

  it("preserves the ref when one linked source is absent from a later candidate group", () => {
    const refs = new InMemoryPersistentRefStore();
    const assembler = createObservationAssembler(refs);
    const mergeKey = "backend:main:doc-a:42";

    const first = assembler.assemble(
      input([
        source("ax", [candidate("ax", "Save", mergeKey)]),
        source("dom", [candidate("dom", "Save", mergeKey)]),
      ]),
    );

    const secondInput = input([
      source("ax", []),
      source("dom", [candidate("dom", "Save")]),
    ]);
    secondInput.revision = {
      ...secondInput.revision,
      id: "state-a:2",
      sequence: 2,
    };

    const second = assembler.assemble(secondInput);

    expect(second.elements[0]!.ref).toBe(first.elements[0]!.ref);
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
      input([
        source("ax", [candidate("ax", "Save")]),
      ]),
    );

    expect(observation.coverage.actionable).toMatchObject({
      status: "unknown",
    });
    expect(observation.warnings).toContain(
      "expected perception source missing: dom",
    );
  });
});
