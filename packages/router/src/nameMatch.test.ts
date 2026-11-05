import { describe, expect, it } from "vitest";
import { exactKey, looseKey } from "./nameMatch.js";

function lookalike(name: string, intent: string): boolean {
  return exactKey(name) !== exactKey(intent) && looseKey(name) === looseKey(intent);
}

describe("exactKey", () => {
  it("applies NFKC, collapses whitespace including NBSP and U+3000, trims", () => {
    expect(exactKey("Ｓａｖｅ")).toBe("Save");
    expect(exactKey("  Save\u00A0\u3000 draft\n")).toBe("Save draft");
  });

  it("keeps case and invisible characters", () => {
    expect(exactKey("save")).not.toBe(exactKey("Save"));
    expect(exactKey("Con\u200Bfirm")).toBe("Con\u200Bfirm");
    expect(exactKey("Confirm \u200B")).not.toBe("Confirm");
  });
});

describe("looseKey lookalikes", () => {
  it.each([
    ["Confirm \u200B", "Confirm"],
    ["\u200B Confirm", "Confirm"],
    ["Con\u200Bfirm", "Confirm"],
    ["Con\uFEFFfirm", "Confirm"],
    ["Con firm", "Confirm"],
    ["Confirm\u2800", "Confirm"],
    ["CONFIRM", "Confirm"],
    ["Cafe\u200B\u0301", "Café"],
    ["ᄒ\u200Bᅡᆫ", "한"],
    ["straße", "STRASSE"],
  ])("treats %j as a lookalike of %j", (name, intent) => {
    expect(lookalike(name, intent)).toBe(true);
  });

  it("does not treat different words as lookalikes", () => {
    expect(lookalike("Cancel", "Confirm")).toBe(false);
    expect(lookalike("Confirm order", "Confirm")).toBe(false);
  });

  it("does not treat an exact match as a lookalike", () => {
    expect(lookalike("Ｃｏｎｆｉｒｍ", "Confirm")).toBe(false);
  });
});
