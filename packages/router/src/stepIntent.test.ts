import { describe, expect, it } from "vitest";
import {
  STEP_INTENT_NAME_MAX_LENGTH,
  parseStepIntent,
} from "./stepIntent.js";

describe("parseStepIntent", () => {
  it("accepts the minimal and the full form and returns a fresh object", () => {
    const minimal = { operation: "click", target: { name: "Save" } };
    const parsed = parseStepIntent(minimal);
    expect(parsed).toEqual(minimal);
    expect(parsed).not.toBe(minimal);
    expect(parsed.target).not.toBe(minimal.target);

    expect(
      parseStepIntent({
        operation: "click",
        target: {
          name: "Pay now",
          role: "menuitem-radio",
          frameOrigin: "https://pay.example.test",
        },
      }),
    ).toEqual({
      operation: "click",
      target: {
        name: "Pay now",
        role: "menuitem-radio",
        frameOrigin: "https://pay.example.test",
      },
    });
  });

  it("accepts a name of exactly the maximum length", () => {
    expect(() =>
      parseStepIntent({
        operation: "click",
        target: { name: "a".repeat(STEP_INTENT_NAME_MAX_LENGTH) },
      }),
    ).not.toThrow();
  });

  it("ignores inherited properties, including a polluted Object.prototype", () => {
    const inherited = {
      operation: "click",
      target: Object.assign(
        Object.create({ frameOrigin: "https://evil.test" }) as Record<string, unknown>,
        { name: "Save" },
      ),
    };
    expect(() => parseStepIntent(inherited)).toThrow("invalid step intent");

    const polluted = Object.prototype as Record<string, unknown>;
    polluted.frameOrigin = "https://evil.test";
    try {
      expect(parseStepIntent({ operation: "click", target: { name: "Save" } })).toEqual({
        operation: "click",
        target: { name: "Save" },
      });
    } finally {
      delete polluted.frameOrigin;
    }
  });

  it("rejects non-enumerable and symbol keys", () => {
    const hidden = { name: "Save" };
    Object.defineProperty(hidden, "ref", { value: "@e_9", enumerable: false });
    expect(() => parseStepIntent({ operation: "click", target: hidden })).toThrow("invalid step intent");
    expect(() =>
      parseStepIntent({ operation: "click", target: { name: "Save", [Symbol("x")]: 1 } }),
    ).toThrow("invalid step intent");
  });

  it("accepts null-prototype records and reads each field once", () => {
    const target = Object.create(null) as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(target, "name", {
      enumerable: true,
      get: () => (reads++ === 0 ? "Save" : "Sa\u200Bve"),
    });
    expect(parseStepIntent({ operation: "click", target })).toEqual({
      operation: "click",
      target: { name: "Save" },
    });
    expect(reads).toBe(1);
  });

  it.each([
    ["non-object", "click"],
    ["class instance", { operation: "click", target: new (class { name = "Save"; })() }],
    ["array", []],
    ["extra top-level key", { operation: "click", target: { name: "Save" }, ref: "@e_1" }],
    ["missing target", { operation: "click" }],
    ["unknown operation", { operation: "setValue", target: { name: "Save" } }],
    ["extra target key", { operation: "click", target: { name: "Save", description: "x" } }],
    ["missing name", { operation: "click", target: {} }],
    ["non-string name", { operation: "click", target: { name: 1 } }],
    ["empty name", { operation: "click", target: { name: "   " } }],
    ["too long", { operation: "click", target: { name: "a".repeat(STEP_INTENT_NAME_MAX_LENGTH + 1) } }],
    ["NFKC expansion beyond the limit", { operation: "click", target: { name: "ﷺ".repeat(20) } }],
    ["control character", { operation: "click", target: { name: "Sa\nve" } }],
    ["zero-width", { operation: "click", target: { name: "Sa\u200Bve" } }],
    ["BOM", { operation: "click", target: { name: "\uFEFFSave" } }],
    ["braille blank", { operation: "click", target: { name: "Save\u2800" } }],
    ["NBSP", { operation: "click", target: { name: "Save\u00A0draft" } }],
    ["lone surrogate", { operation: "click", target: { name: "Save\uD800" } }],
    ["uppercase role", { operation: "click", target: { name: "Save", role: "Button" } }],
    ["role with space", { operation: "click", target: { name: "Save", role: "push button" } }],
    ["origin with path", { operation: "click", target: { name: "Save", frameOrigin: "https://a.test/x" } }],
    ["origin with trailing slash", { operation: "click", target: { name: "Save", frameOrigin: "https://a.test/" } }],
    ["origin with query", { operation: "click", target: { name: "Save", frameOrigin: "https://a.test?x=1" } }],
    ["origin with credentials", { operation: "click", target: { name: "Save", frameOrigin: "https://u:p@a.test" } }],
    ["non-http origin", { operation: "click", target: { name: "Save", frameOrigin: "chrome-extension://abc" } }],
    ["opaque origin", { operation: "click", target: { name: "Save", frameOrigin: "null" } }],
    ["unparseable origin", { operation: "click", target: { name: "Save", frameOrigin: "not a url" } }],
  ])("rejects %s with a fixed message", (_label, value) => {
    expect(() => parseStepIntent(value)).toThrow(
      expect.objectContaining({
        code: "POLICY_BLOCKED",
        message: "invalid step intent",
      }),
    );
  });
});
