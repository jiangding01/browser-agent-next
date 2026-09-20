import { describe, expect, it } from "vitest";
import {
  isObserveDomFrameRequest,
  isObserveTabRequest,
} from "./perception.js";

describe("perception request validation", () => {
  it("rejects unbounded DOM and AX observation options", () => {
    expect(isObserveDomFrameRequest({
      type: "perception.observe-dom",
      requestId: "dom",
      options: { maxElements: 501 },
    })).toBe(false);

    expect(isObserveTabRequest({
      type: "perception.observe-tab",
      requestId: "tab",
      tabId: 7,
      options: { maxElements: 501 },
    })).toBe(false);

    expect(isObserveTabRequest({
      type: "perception.observe-tab",
      requestId: "tab",
      tabId: 7,
      options: { includeAx: true, maxAxElements: 501 },
    })).toBe(false);
  });

  it("accepts bounded DOM and AX observation options", () => {
    expect(isObserveDomFrameRequest({
      type: "perception.observe-dom",
      requestId: "dom",
      options: {
        maxElements: 500,
        includeValues: true,
        includeOpenShadowRoots: false,
      },
    })).toBe(true);

    expect(isObserveTabRequest({
      type: "perception.observe-tab",
      requestId: "tab",
      tabId: 7,
      sinceRevision: "runtime:g1:t7",
      options: {
        maxElements: 500,
        includeValues: false,
        includeOpenShadowRoots: true,
        includeAx: true,
        maxAxElements: 500,
      },
    })).toBe(true);
  });
});
