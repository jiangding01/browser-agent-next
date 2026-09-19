import { describe, expect, it } from "vitest";
import { TabRevisionRegistry } from "./tabRevisionRegistry.js";

describe("TabRevisionRegistry", () => {
  it("mints runtime-global opaque revisions so tab-id reuse cannot alias old state", () => {
    const registry = new TabRevisionRegistry("runtime-a");

    expect(registry.next(7, "doc-a")).toEqual({
      id: "runtime-a:g1:t7",
      stateEpoch: "runtime-a",
      documentEpoch: "doc-a",
      sequence: 1,
    });

    expect(registry.next(7, "doc-a").id).toBe("runtime-a:g2:t7");
    expect(registry.next(8, "doc-b").id).toBe("runtime-a:g3:t8");
    expect(registry.next(7, "doc-c").id).toBe("runtime-a:g4:t7");
  });
});
