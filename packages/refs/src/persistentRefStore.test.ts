import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "./persistentRefStore.js";

describe("InMemoryPersistentRefStore", () => {
  it("keeps the same ref for the same DOM identity", () => {
    const store = new InMemoryPersistentRefStore();
    const identity = { source: "dom" as const, tabId: 1, frameEpoch: "frame-a", stableId: "s1" };
    const first = store.getOrCreate(identity, "element", "r1");
    const second = store.getOrCreate(identity, "element", "r2");
    expect(second).toBe(first);
    expect(store.byRef(first)?.lastSeenRevision).toBe("r2");
  });

  it("does not recycle a tombstoned ref", () => {
    const store = new InMemoryPersistentRefStore();
    const identity = { source: "dom" as const, tabId: 1, frameEpoch: "frame-a", stableId: "s1" };
    const first = store.getOrCreate(identity, "element", "r1");
    store.tombstone(first, "r2", "node-replaced");
    const next = store.getOrCreate(identity, "element", "r3");
    expect(next).not.toBe(first);
  });

  it("binds AX identity to document epoch", () => {
    const store = new InMemoryPersistentRefStore();
    const first = store.getOrCreate(
      { source: "ax", tabId: 1, cdpFrameId: "main", documentEpoch: "doc-a", backendNodeId: 42 },
      "element",
      "r1",
    );
    const second = store.getOrCreate(
      { source: "ax", tabId: 1, cdpFrameId: "main", documentEpoch: "doc-b", backendNodeId: 42 },
      "element",
      "r2",
    );
    expect(second).not.toBe(first);
  });
});
