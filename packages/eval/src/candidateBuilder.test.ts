import { describe, expect, it } from "vitest";
import { observationOrderCandidateBuilder } from "./candidateBuilder.js";
import {
  fixtureButton,
  fixtureObservation,
} from "./foundationFixtures.js";

describe("observationOrderCandidateBuilder", () => {
  it("keeps visible, enabled clickable elements in observation order", () => {
    const observation = fixtureObservation({
      frames: [
        { frameId: "main", documentEpoch: "doc-a", accessible: true },
        {
          frameId: "child-1",
          parentFrameId: "main",
          documentEpoch: "doc-child",
          accessible: true,
        },
      ],
      elements: [
        fixtureButton("@e_3", "Third"),
        fixtureButton("@e_1", "Hidden", { visible: false }),
        fixtureButton("@e_2", "Disabled", { enabled: false }),
        fixtureButton("@f_1", "Field", {
          kind: "field",
          capabilities: [{ kind: "setValue" }],
        }),
        fixtureButton("@e_4", "Occluded", { hitTestable: false }),
        fixtureButton("@e_5", "Child", { frameId: "child-1" }),
      ],
    });

    expect(observationOrderCandidateBuilder().build(observation, "goal")).toEqual({
      refs: ["@e_3", "@e_4", "@e_5"],
      coverage: "complete",
      totalKnown: 3,
    });
  });

  it("marks the candidate set truncated when it exceeds maxCandidates", () => {
    const observation = fixtureObservation({
      elements: [
        fixtureButton("@e_1", "One"),
        fixtureButton("@e_2", "Two"),
        fixtureButton("@e_3", "Three"),
      ],
    });

    expect(
      observationOrderCandidateBuilder({ maxCandidates: 2 }).build(observation, "goal"),
    ).toEqual({
      refs: ["@e_1", "@e_2"],
      coverage: "truncated",
      totalKnown: 3,
    });
  });

  it("never upgrades incomplete observation coverage", () => {
    for (const status of ["truncated", "partial", "unknown"] as const) {
      const observation = fixtureObservation({
        elements: [fixtureButton("@e_1", "One")],
        actionableCoverage: { status, returned: 1 },
      });

      expect(
        observationOrderCandidateBuilder().build(observation, "goal").coverage,
      ).toBe(status);
    }
  });

  it("rejects out-of-range maxCandidates", () => {
    for (const maxCandidates of [0, 501, 1.5, Number.NaN]) {
      expect(() => observationOrderCandidateBuilder({ maxCandidates })).toThrow(
        /maxCandidates/,
      );
    }
  });
});
