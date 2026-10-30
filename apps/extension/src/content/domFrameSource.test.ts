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
      readonly textSecurity = "",
    ) {}
    getAttribute(name: string): string | null {
      return name === "autocomplete" ? this.autocomplete : null;
    }
  }
  class FakeTextArea extends FakeInput {}
  class FakeSelect extends FakeInput {}

  const win = {
    getComputedStyle: (element: FakeInput) => ({
      getPropertyValue: (name: string) =>
        name === "-webkit-text-security" ? element.textSecurity : "",
    }),
  } as unknown as Window;

  function withFakes(run: () => void): void {
    const scope = globalThis as {
      HTMLInputElement?: unknown;
      HTMLTextAreaElement?: unknown;
      HTMLSelectElement?: unknown;
    };
    const previous = [scope.HTMLInputElement, scope.HTMLTextAreaElement, scope.HTMLSelectElement];
    scope.HTMLInputElement = FakeInput;
    scope.HTMLTextAreaElement = FakeTextArea;
    scope.HTMLSelectElement = FakeSelect;
    try {
      run();
    } finally {
      [scope.HTMLInputElement, scope.HTMLTextAreaElement, scope.HTMLSelectElement] = previous;
    }
  }

  it("checks autocomplete on textareas and treats text-security masking as sensitive", () => {
    withFakes(() => {
      const sensitive = (input: FakeInput) => isSensitiveField(input as unknown as Element, win);
      expect(sensitive(new FakeTextArea("textarea", "one-time-code"))).toBe(true);
      expect(sensitive(new FakeTextArea("textarea", "cc-number"))).toBe(true);
      expect(sensitive(new FakeTextArea("textarea", "street-address"))).toBe(false);
      expect(sensitive(new FakeInput("text", null, "disc"))).toBe(true);
      expect(sensitive(new FakeTextArea("textarea", null, "square"))).toBe(true);
      expect(sensitive(new FakeInput("text", null, "none"))).toBe(false);
      expect(sensitive(new FakeSelect("select-one", "cc-exp-month"))).toBe(true);
      expect(sensitive(new FakeSelect("select-one", "country"))).toBe(false);
    });
  });

  it("flags password and credential / payment autocomplete inputs only", () => {
    withFakes(() => {
      const sensitive = (input: FakeInput) => isSensitiveField(input as unknown as Element, win);

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
      expect(isSensitiveField({} as Element, win)).toBe(false);
    });
  });
});
