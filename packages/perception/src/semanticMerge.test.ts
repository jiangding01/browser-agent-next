import { describe, expect, it } from "vitest";
import { mergePerceptionCandidates } from "./semanticMerge.js";

describe("mergePerceptionCandidates", () => {
  it("exact mergeKey 可把同一 live node 的 element/field 分类收敛为 field", () => {
    const merged = mergePerceptionCandidates([
      {
        source: "dom",
        mergeKey: "backend:main:doc:42",
        identity: {
          source: "dom",
          tabId: 1,
          frameEpoch: "frame-a",
          stableId: "s1",
        },
        kind: "field",
        semantic: { role: "button", name: "Upload" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "upload" }],
      },
      {
        source: "ax",
        mergeKey: "backend:main:doc:42",
        identity: {
          source: "ax",
          tabId: 1,
          cdpFrameId: "main",
          documentEpoch: "doc",
          backendNodeId: 42,
        },
        kind: "element",
        semantic: { role: "button", name: "Upload" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("field");
    expect(merged[0]?.identities).toHaveLength(2);
    expect(merged[0]?.capabilities.map((entry) => entry.kind).sort()).toEqual([
      "click",
      "upload",
    ]);
  });
});
