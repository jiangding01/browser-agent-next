import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "@browser-agent-next/core";
import { TabStateStore } from "./tabStateStore.js";

function observation(tabId: number, revision: string): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId,
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
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
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
    elements: [{
      ref: "@e_1",
      kind: "element",
      semantic: { role: "button", name: "Continue" },
      state: { visible: true, enabled: true, focused: false },
      frameId: "main",
      capabilities: [{ kind: "click" }],
      provenance: { ax: true },
    }],
  };
}

describe("TabStateStore", () => {
  it("indexes stored elements by ref", () => {
    const store = new TabStateStore();
    const stored = store.put(observation(1, "r1"));
    expect(stored.byRef.get("@e_1")?.semantic.name).toBe("Continue");
  });

  it("keeps only the configured number of revisions", () => {
    const store = new TabStateStore({ maxRevisionsPerTab: 2 });
    store.put(observation(1, "r1"));
    store.put(observation(1, "r2"));
    store.put(observation(1, "r3"));

    expect(store.get(1, "r1")).toBeUndefined();
    expect(store.get(1, "r2")).toBeDefined();
    expect(store.get(1, "r3")).toBeDefined();
  });

  it("isolates tabs", () => {
    const store = new TabStateStore({ maxRevisionsPerTab: 1 });
    store.put(observation(1, "r1"));
    store.put(observation(2, "r1"));
    store.put(observation(1, "r2"));

    expect(store.get(1, "r1")).toBeUndefined();
    expect(store.get(2, "r1")).toBeDefined();
  });
});
