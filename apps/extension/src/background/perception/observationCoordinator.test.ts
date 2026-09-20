import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  DomObservationCoordinator,
  type ObserveTabInput,
} from "./observationCoordinator.js";
import type { DomFrameSnapshot } from "../../content/domFrameSource.js";

function snapshot(
  name: string | undefined,
  stableId = "s1",
): DomFrameSnapshot {
  const elements = name === undefined
    ? []
    : [
        {
          stableId,
          kind: "element" as const,
          semantic: { role: "button", name },
          state: { visible: true, enabled: true, focused: false },
          capabilities: [{ kind: "click" as const }],
        },
      ];

  return {
    source: "dom",
    frameEpoch: "frame-epoch-a",
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1280,
      scrollHeight: 720,
    },
    elements,
    coverage: {
      actionable: {
        status: "complete",
        returned: elements.length,
        totalKnown: elements.length,
      },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0, reason: "not-scanned" },
    },
    openShadowRootCount: 0,
  };
}

function input(
  name: string | undefined,
  stableId = "s1",
): ObserveTabInput {
  return {
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://fixture.test/",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    frames: [
      {
        frameId: "web:0",
        documentEpoch: "chrome-document:doc-a",
        accessible: true,
      },
    ],
    domFrames: [
      {
        frameId: "web:0",
        transportFrameId: 0,
        documentId: "doc-a",
        accessible: true,
      },
    ],
    mainFrameId: "web:0",
    mainDocumentEpoch: "chrome-document:doc-a",
    transport: {
      async send(_tabId: number, _target: unknown, request: { requestId: string }) {
        return {
          type: "perception.observe-dom.result" as const,
          requestId: request.requestId,
          ok: true as const,
          snapshot: snapshot(name, stableId),
        };
      },
    },
  };
}

describe("DomObservationCoordinator", () => {
  it("assembles and stores a canonical observation", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );

    const observation = await coordinator.observe(input("Save"));

    expect(observation.revision.id).toBe("runtime-a:g1:t7");
    expect(observation.elements[0]).toMatchObject({
      ref: "@e_1",
      semantic: { role: "button", name: "Save" },
    });
    expect(states.get(7, observation.revision.id)).toBeDefined();
  });

  it("keeps a persistent ref and emits a keyed delta on a later observation", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );

    const first = await coordinator.observe(input("Save"));
    const second = await coordinator.observe({
      ...input("Save changes"),
      sinceRevision: first.revision.id,
    });

    expect(second.elements[0]!.ref).toBe(first.elements[0]!.ref);
    expect(second.delta).toMatchObject({
      baseRevision: first.revision.id,
      revision: second.revision.id,
      changes: [
        {
          type: "update",
          ref: first.elements[0]!.ref,
        },
      ],
    });
  });

  it("tombstones a disappeared actionable ref only after a complete same-document observation", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );

    const first = await coordinator.observe(input("Save", "s1"));
    const oldRef = first.elements[0]!.ref;

    const second = await coordinator.observe({
      ...input("Save", "s2"),
      sinceRevision: first.revision.id,
    });

    expect(second.elements[0]!.ref).not.toBe(oldRef);
    expect(refs.byRef(oldRef)?.tombstoneReason).toBe(
      "not-present-in-complete-observation",
    );
  });

  it("does not tombstone missing refs when current coverage is partial", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );

    const first = await coordinator.observe(input("Save", "s1"));
    const oldRef = first.elements[0]!.ref;

    const partial = input("Save", "s2");
    partial.domFrames.push({
      frameId: "web:7",
      transportFrameId: 7,
      accessible: false,
    });
    partial.frames.push({
      frameId: "web:7",
      parentFrameId: "web:0",
      documentEpoch: "chrome-document:doc-child",
      accessible: false,
    });

    await coordinator.observe({
      ...partial,
      sinceRevision: first.revision.id,
    });

    expect(refs.byRef(oldRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("does not tombstone an open-shadow ref when that profile is excluded", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );

    const first = await coordinator.observe(input("Shadow Save", "s1"));
    const shadowRef = first.elements[0]!.ref;

    const withoutOpenRoots = await coordinator.observe({
      ...input(undefined),
      sinceRevision: first.revision.id,
      domOptions: { includeOpenShadowRoots: false },
    });

    expect(withoutOpenRoots.coverage.actionable.status).toBe("complete");
    expect(withoutOpenRoots.coverage.shadowDom.openRootsCovered).toBe(false);
    expect(refs.byRef(shadowRef)?.tombstonedAtRevision).toBeUndefined();

    const restored = await coordinator.observe({
      ...input("Shadow Save", "s1"),
      sinceRevision: withoutOpenRoots.revision.id,
    });

    expect(restored.elements[0]!.ref).toBe(shadowRef);
  });

  it("refineSources 可在 assembler 前把 DOM 与 AX 收敛为同一 Persistent Ref", async () => {
    const refs = new InMemoryPersistentRefStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      new TabStateStore(),
    );

    const base = input("Save");

    const observation = await coordinator.observe({
      ...base,
      extraSources: [
        {
          source: "ax",
          coverage: {
            actionable: { status: "complete", returned: 1, totalKnown: 1 },
            forms: { status: "complete", returned: 0, totalKnown: 0 },
            text: { status: "unknown", returned: 0 },
          },
          elements: [
            {
              source: "ax",
              identity: {
                source: "ax",
                tabId: 7,
                cdpFrameId: "cdp-main",
                documentEpoch: "chrome-document:doc-a",
                backendNodeId: 42,
              },
              kind: "element",
              semantic: { role: "button", name: "Save" },
              state: { visible: true, enabled: true, focused: false },
              frameId: "web:0",
              capabilities: [{ kind: "click" }],
            },
          ],
        },
      ],
      refineSources: async ({ dom, extraSources }) => {
        const key = "backend:cdp-main:chrome-document:doc-a:42";
        return {
          dom: {
            ...dom,
            elements: dom.elements.map((element) => ({
              ...element,
              mergeKey: key,
            })),
          },
          extraSources: extraSources.map((source) => ({
            ...source,
            elements: source.elements.map((element) => ({
              ...element,
              mergeKey: key,
            })),
          })),
        };
      },
    });

    expect(observation.elements).toHaveLength(1);
    const record = refs.byRef(observation.elements[0]!.ref);
    expect(record?.aliases).toHaveLength(1);
  });

  it("reports an unavailable delta baseline instead of fabricating a delta", async () => {
    const coordinator = new DomObservationCoordinator(
      new InMemoryPersistentRefStore(),
      new TabRevisionRegistry("runtime-a"),
      new TabStateStore(),
    );

    const observation = await coordinator.observe({
      ...input("Save"),
      sinceRevision: "missing",
    });

    expect(observation.delta).toBeUndefined();
    expect(observation.warnings).toContain(
      "delta baseline unavailable: missing",
    );
  });
});
