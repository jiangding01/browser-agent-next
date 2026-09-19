import { describe, expect, it } from "vitest";
import { createCoverageState } from "./coverage.js";

describe("createCoverageState", () => {
  it("marks a fully counted observation complete", () => {
    expect(createCoverageState({ returned: 7, totalKnown: 7 })).toEqual({
      status: "complete",
      returned: 7,
      totalKnown: 7,
    });
  });

  it("does not infer completeness when total count is unknown", () => {
    expect(createCoverageState({ returned: 7 })).toEqual({
      status: "unknown",
      returned: 7,
    });
  });

  it("keeps truncation explicit", () => {
    expect(createCoverageState({
      returned: 40,
      totalKnown: 93,
      truncated: true,
      reason: "output-cap",
    })).toEqual({
      status: "truncated",
      returned: 40,
      totalKnown: 93,
      reason: "output-cap",
    });
  });

  it("turns unexplained missing items into partial instead of complete", () => {
    expect(createCoverageState({ returned: 3, totalKnown: 5 })).toEqual({
      status: "partial",
      returned: 3,
      totalKnown: 5,
      reason: "returned-less-than-total-known",
    });
  });

  it("rejects contradictory or impossible counts", () => {
    expect(() => createCoverageState({ returned: 6, totalKnown: 5 })).toThrow();
    expect(() => createCoverageState({ returned: 1, truncated: true, partial: true })).toThrow();
  });
});
