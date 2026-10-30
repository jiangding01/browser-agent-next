import { describe, expect, it } from "vitest";
import {
  STRICT_VALUE_MAX_LENGTH,
  canonicalStrictActionArgs,
  parseStrictActionArgs,
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
