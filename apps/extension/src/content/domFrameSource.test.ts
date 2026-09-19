import { describe, expect, it } from "vitest";
import { StableDomIdRegistry } from "./domFrameSource.js";

describe("StableDomIdRegistry", () => {
  it("keeps identity stable for the same live object", () => {
    const registry = new StableDomIdRegistry();
    const first = {} as Element;
    const second = {} as Element;

    expect(registry.idFor(first)).toBe("s1");
    expect(registry.idFor(first)).toBe("s1");
    expect(registry.idFor(second)).toBe("s2");
  });
});
