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

  it("links independently sourced identities only when the perception layer proves correspondence", () => {
    const store = new InMemoryPersistentRefStore();
    const dom = { source: "dom" as const, tabId: 1, frameEpoch: "frame-a", stableId: "s1" };
    const ax = {
      source: "ax" as const,
      tabId: 1,
      cdpFrameId: "main",
      documentEpoch: "doc-a",
      backendNodeId: 42,
    };

    const ref = store.getOrCreateLinked([dom, ax], "element", "r1");

    expect(store.getOrCreate(dom, "element", "r2")).toBe(ref);
    expect(store.getOrCreate(ax, "element", "r3")).toBe(ref);
    expect(store.byRef(ref)?.aliases).toEqual([ax]);
  });

  it("fails closed instead of merging two already-distinct active refs", () => {
    const store = new InMemoryPersistentRefStore();
    const dom = { source: "dom" as const, tabId: 1, frameEpoch: "frame-a", stableId: "s1" };
    const ax = {
      source: "ax" as const,
      tabId: 1,
      cdpFrameId: "main",
      documentEpoch: "doc-a",
      backendNodeId: 42,
    };

    store.getOrCreate(dom, "element", "r1");
    store.getOrCreate(ax, "element", "r1");

    expect(() => store.getOrCreateLinked([dom, ax], "element", "r2")).toThrow(
      /different active refs/,
    );
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

  it("invalidates a linked ref when either strong frame identity is invalidated", () => {
    const store = new InMemoryPersistentRefStore();
    const dom = { source: "dom" as const, tabId: 1, frameEpoch: "frame-a", stableId: "s1" };
    const ax = {
      source: "ax" as const,
      tabId: 1,
      cdpFrameId: "cdp-a",
      documentEpoch: "doc-a",
      backendNodeId: 42,
    };

    const ref = store.getOrCreateLinked([dom, ax], "element", "r1");
    store.invalidateFrame({ tabId: 1, cdpFrameId: "cdp-a" }, "r2");

    expect(store.byRef(ref)?.tombstonedAtRevision).toBe("r2");
  });

  it("bounds retained tombstones without recycling ref ids", () => {
    const store = new InMemoryPersistentRefStore({ maxTombstones: 1 });

    const first = store.getOrCreate(
      { source: "dom", tabId: 1, frameEpoch: "frame", stableId: "a" },
      "element",
      "r1",
    );
    store.tombstone(first, "r2", "gone");

    const second = store.getOrCreate(
      { source: "dom", tabId: 1, frameEpoch: "frame", stableId: "b" },
      "element",
      "r3",
    );
    store.tombstone(second, "r4", "gone");

    expect(store.tombstoneCount()).toBe(1);
    expect(store.byRef(first)).toBeUndefined();

    const third = store.getOrCreate(
      { source: "dom", tabId: 1, frameEpoch: "frame", stableId: "c" },
      "element",
      "r5",
    );

    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
