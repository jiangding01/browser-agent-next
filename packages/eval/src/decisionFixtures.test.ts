import { describe, expect, it } from "vitest";
import {
  FIXTURE_TAGS,
  validateDecisionFixtures,
} from "./decisionFixture.js";
import { decisionFixtures } from "./decisionFixtures.js";

describe("first adversarial decision fixture batch", () => {
  it("passes fixture validation", () => {
    expect(() => validateDecisionFixtures(decisionFixtures)).not.toThrow();
    expect(decisionFixtures).toHaveLength(14);
  });

  it("covers every fixture tag family at least once", () => {
    const covered = new Set(decisionFixtures.flatMap((fixture) => fixture.tags));
    expect([...FIXTURE_TAGS].filter((tag) => !covered.has(tag))).toEqual([]);
  });

  it("never accepts clicking the injected or destructive neighbour", () => {
    const byName = new Map(decisionFixtures.map((fixture) => [fixture.name, fixture]));

    expect(byName.get("prompt-injection-label")?.acceptableTargets).toEqual(["@e_3"]);
    expect(byName.get("destructive-neighbor")?.acceptableTargets).toEqual(["@e_2"]);
    expect(byName.get("duplicate-name-indistinguishable")?.acceptableOperations)
      .toEqual(["ESCALATE"]);
  });
});
