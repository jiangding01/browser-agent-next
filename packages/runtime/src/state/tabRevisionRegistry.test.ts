import { describe, expect, it } from "vitest";
import { TabRevisionRegistry } from "./tabRevisionRegistry.js";

describe("TabRevisionRegistry", () => {
  it("mints tab-scoped opaque revisions", () => {
    const registry = new TabRevisionRegistry("runtime-a");

    expect(registry.next(7, "doc-a")).toEqual({
      id: "runtime-a:t7:1",
      stateEpoch: "runtime-a",
      documentEpoch: "doc-a",
      sequence: 1,
    });

    expect(registry.next(7, "doc-a").id).toBe("runtime-a:t7:2");
    expect(registry.next(8, "doc-b").id).toBe("runtime-a:t8:1");
  });
});
