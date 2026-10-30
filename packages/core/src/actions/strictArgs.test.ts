import { describe, expect, it } from "vitest";
import {
  STRICT_KEYS,
  STRICT_VALUE_MAX_LENGTH,
  canonicalStrictActionArgs,
  parseStrictActionArgs,
  strictArgsFromActAction,
} from "./strictArgs.js";

describe("parseStrictActionArgs", () => {
  it("accepts click and single-line setValue, including empty and CJK values", () => {
    expect(parseStrictActionArgs({ kind: "click" })).toEqual({ kind: "click" });
    for (const value of ["", "hello", "  padded  ", "张三 Zhang", "a".repeat(STRICT_VALUE_MAX_LENGTH), "👍"]) {
      expect(parseStrictActionArgs({ kind: "setValue", value })).toEqual({ kind: "setValue", value });
    }
  });

  it("rejects malformed shapes", () => {
    for (const input of [
      null,
      "click",
      [],
      { kind: "type", value: "x" },
      { kind: "click", value: "x" },
      { kind: "setValue" },
      { kind: "setValue", value: 1 },
      { kind: "setValue", value: "x", extra: true },
    ]) {
      expect(() => parseStrictActionArgs(input), JSON.stringify(input)).toThrow(
        expect.objectContaining({ code: "POLICY_BLOCKED" }),
      );
    }
  });

  it("rejects overlong values and every character class the approval page cannot show faithfully", () => {
    const rejected = [
      "a".repeat(STRICT_VALUE_MAX_LENGTH + 1),
      "line1\nline2",
      "tab\there",
      "cr\r",
      "nul\u0000",
      "zero\u200Bwidth",
      "joiner\u200D",
      "bidi\u202Eevil",
      "isolate\u2066x\u2069",
      "bom\uFEFF",
      "soft\u00ADhyphen",
      "variation\uFE0F",
      "hangul\u3164filler",
      "nbsp\u00A0space",
      "ideographic\u3000space",
      "line\u2028sep",
      "para\u2029sep",
      "braille\u2800blank",
      "lone\uD800",
      "lone\uDC00",
    ];
    for (const value of rejected) {
      expect(
        () => parseStrictActionArgs({ kind: "setValue", value }),
        JSON.stringify(value),
      ).toThrow(expect.objectContaining({ code: "POLICY_BLOCKED" }));
    }
  });

  it("never echoes the value in its error message", () => {
    try {
      parseStrictActionArgs({ kind: "setValue", value: "secret\u200B" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret");
    }
  });
});

describe("canonicalStrictActionArgs", () => {
  it("is deterministic and distinguishes kinds and values", () => {
    expect(canonicalStrictActionArgs({ kind: "click" })).toBe('{"kind":"click"}');
    expect(canonicalStrictActionArgs({ kind: "setValue", value: "A" })).toBe(
      '{"kind":"setValue","value":"A"}',
    );
    expect(canonicalStrictActionArgs({ kind: "setValue", value: "A" })).not.toBe(
      canonicalStrictActionArgs({ kind: "setValue", value: "B" }),
    );
    expect(canonicalStrictActionArgs({ kind: "setValue", value: "" })).not.toBe(
      canonicalStrictActionArgs({ kind: "click" }),
    );
  });
});

describe("S2 strict action args", () => {
  it("accepts selectOption, submit and the four allowed keys", () => {
    expect(parseStrictActionArgs({ kind: "selectOption", label: "北京 Beijing" })).toEqual({
      kind: "selectOption",
      label: "北京 Beijing",
    });
    expect(parseStrictActionArgs({ kind: "submit" })).toEqual({ kind: "submit" });
    for (const key of STRICT_KEYS) {
      expect(parseStrictActionArgs({ kind: "pressKey", key })).toEqual({ kind: "pressKey", key });
    }
  });

  it("rejects malformed S2 shapes, Enter and undisplayable labels", () => {
    for (const input of [
      { kind: "selectOption" },
      { kind: "selectOption", label: "" },
      { kind: "selectOption", label: 1 },
      { kind: "selectOption", value: "x" },
      { kind: "selectOption", label: "x", value: "x" },
      { kind: "selectOption", label: "a\u200Bb" },
      { kind: "selectOption", label: "a".repeat(STRICT_VALUE_MAX_LENGTH + 1) },
      { kind: "submit", value: "x" },
      { kind: "pressKey" },
      { kind: "pressKey", key: "Enter" },
      { kind: "pressKey", key: "NumpadEnter" },
      { kind: "pressKey", key: "escape" },
      { kind: "pressKey", key: "Tab", value: "x" },
      { kind: "setValue", value: "x", label: "x" },
    ]) {
      expect(() => parseStrictActionArgs(input), JSON.stringify(input)).toThrow(
        expect.objectContaining({ code: "POLICY_BLOCKED" }),
      );
    }
  });

  it("canonicalises every kind distinctly and deterministically", () => {
    const all = [
      { kind: "click" },
      { kind: "setValue", value: "A" },
      { kind: "selectOption", label: "A" },
      { kind: "submit" },
      { kind: "pressKey", key: "Tab" },
      { kind: "pressKey", key: "Escape" },
    ] as const;
    const canonical = all.map((args) => canonicalStrictActionArgs(args));
    expect(new Set(canonical).size).toBe(all.length);
    expect(canonicalStrictActionArgs({ kind: "selectOption", label: "A" })).toBe(
      '{"kind":"selectOption","label":"A"}',
    );
    expect(canonicalStrictActionArgs({ kind: "pressKey", key: "Tab" })).toBe(
      '{"kind":"pressKey","key":"Tab"}',
    );
  });
});

describe("strictArgsFromActAction", () => {
  it("assembles args from the act action's parameter fields only", () => {
    expect(strictArgsFromActAction({ kind: "click" })).toEqual({ kind: "click" });
    expect(strictArgsFromActAction({ kind: "selectOption", label: "A" })).toEqual({
      kind: "selectOption",
      label: "A",
    });
    expect(strictArgsFromActAction({ kind: "pressKey", key: "Tab" })).toEqual({
      kind: "pressKey",
      key: "Tab",
    });
    for (const action of [
      { kind: "click", label: "A" },
      { kind: "selectOption", value: "A" },
      { kind: "submit", key: "Tab" },
      { kind: "setValue" },
      { kind: "check" },
    ]) {
      expect(() => strictArgsFromActAction(action), JSON.stringify(action)).toThrow(
        expect.objectContaining({ code: "POLICY_BLOCKED" }),
      );
    }
  });
});
