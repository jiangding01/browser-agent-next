import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import { TabStateStore } from "@browser-agent-next/runtime";
import { DomLifecycleRegistry } from "./domLifecycleRegistry.js";

describe("DomLifecycleRegistry", () => {
  it("invalidates only the previous child-frame DOM epoch on child navigation", () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const lifecycle = new DomLifecycleRegistry(refs, states);

    const child = refs.getOrCreate(
      {
        source: "dom",
        tabId: 1,
        frameEpoch: "child-epoch-a",
        stableId: "s1",
      },
      "element",
      "r1",
    );

    const main = refs.getOrCreate(
      {
        source: "dom",
        tabId: 1,
        frameEpoch: "main-epoch-a",
        stableId: "s2",
      },
      "element",
      "r1",
    );

    lifecycle.recordObserved(1, {
      "web:0": "main-epoch-a",
      "web:7": "child-epoch-a",
    });

    lifecycle.committed({
      tabId: 1,
      frameId: 7,
      documentId: "doc-child-b",
    });

    expect(refs.byRef(child)?.tombstonedAtRevision).toBe(
      "navigation:doc-child-b",
    );
    expect(refs.byRef(main)?.tombstonedAtRevision).toBeUndefined();
  });

  it("invalidates the whole tab on main-frame commit", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(refs, new TabStateStore());

    const ref = refs.getOrCreate(
      {
        source: "dom",
        tabId: 1,
        frameEpoch: "main-epoch-a",
        stableId: "s1",
      },
      "element",
      "r1",
    );

    lifecycle.committed({
      tabId: 1,
      frameId: 0,
      documentId: "doc-main-b",
    });

    expect(refs.byRef(ref)?.tombstonedAtRevision).toBe(
      "navigation:doc-main-b",
    );
  });
});
