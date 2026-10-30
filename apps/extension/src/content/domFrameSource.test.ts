import { describe, expect, it } from "vitest";
import { StableDomIdRegistry, isSensitiveField } from "./domFrameSource.js";

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

describe("isSensitiveField", () => {
  class FakeInput {
    constructor(
      readonly type: string,
      private readonly autocomplete: string | null = null,
    ) {}
    getAttribute(name: string): string | null {
      return name === "autocomplete" ? this.autocomplete : null;
    }
  }

  it("flags password and credential / payment autocomplete inputs only", () => {
    const previous = (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
    (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = FakeInput;
    try {
      const sensitive = (input: FakeInput) => isSensitiveField(input as unknown as Element);

      expect(sensitive(new FakeInput("password"))).toBe(true);
      expect(sensitive(new FakeInput("PASSWORD"))).toBe(true);
      for (const token of [
        "current-password",
        "new-password",
        "one-time-code",
        "cc-number",
        "cc-csc",
        "billing cc-exp",
        "section-a CC-NUMBER",
      ]) {
        expect(sensitive(new FakeInput("text", token)), token).toBe(true);
      }
      for (const token of [null, "email", "username", "off", "name", "password-hint"]) {
        expect(sensitive(new FakeInput("text", token)), String(token)).toBe(false);
      }
      expect(isSensitiveField({} as Element)).toBe(false);
    } finally {
      (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = previous;
    }
  });
});
