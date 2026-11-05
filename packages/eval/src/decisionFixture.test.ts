import { describe, expect, it } from "vitest";
import {
  validateDecisionFixtures,
  type DecisionFixture,
} from "./decisionFixture.js";
import {
  fixtureButton,
  fixtureObservation,
} from "./foundationFixtures.js";

function validFixture(overrides: Partial<DecisionFixture> = {}): DecisionFixture {
  return {
    name: "valid-fixture",
    microGoal: "Save the draft",
    observation: fixtureObservation({
      elements: [
        fixtureButton("@e_1", "Save"),
        fixtureButton("@e_2", "Cancel"),
      ],
    }),
    acceptableOperations: ["CLICK"],
    acceptableTargets: ["@e_1"],
    tags: ["replacement"],
    ...overrides,
  };
}

function rejects(fixture: DecisionFixture, message: RegExp): void {
  expect(() => validateDecisionFixtures([fixture])).toThrow(message);
}

describe("validateDecisionFixtures", () => {
  it("accepts a well-formed fixture set", () => {
    expect(() =>
      validateDecisionFixtures([
        validFixture(),
        validFixture({
          name: "escalate-only",
          acceptableOperations: ["ESCALATE"],
          acceptableTargets: [],
        }),
      ]),
    ).not.toThrow();
  });

  it("rejects malformed or overlong names", () => {
    rejects(validFixture({ name: "Not Kebab" }), /kebab-case/);
    rejects(validFixture({ name: "a".repeat(65) }), /kebab-case/);
    rejects(validFixture({ name: "trailing-" }), /kebab-case/);
  });

  it("rejects duplicate fixture names", () => {
    expect(() =>
      validateDecisionFixtures([validFixture(), validFixture()]),
    ).toThrow(/names must be unique/);
  });

  it("rejects empty or overlong micro goals", () => {
    rejects(validFixture({ microGoal: "   " }), /microGoal/);
    rejects(validFixture({ microGoal: "x".repeat(501) }), /microGoal/);
  });

  it("rejects empty, duplicate or unknown operations", () => {
    rejects(validFixture({ acceptableOperations: [] }), /acceptableOperations/);
    rejects(
      validFixture({ acceptableOperations: ["CLICK", "CLICK"] }),
      /acceptableOperations/,
    );
    rejects(
      validFixture({
        acceptableOperations: ["TYPE" as never],
        acceptableTargets: [],
      }),
      /acceptableOperations/,
    );
  });

  it("requires targets exactly when CLICK is acceptable", () => {
    rejects(validFixture({ acceptableTargets: [] }), /exactly when CLICK/);
    const { acceptableTargets: _omitted, ...withoutTargets } = validFixture();
    rejects(withoutTargets, /exactly when CLICK/);
    rejects(
      validFixture({ acceptableOperations: ["ESCALATE"] }),
      /exactly when CLICK/,
    );
  });

  it("rejects duplicate targets", () => {
    rejects(
      validFixture({ acceptableTargets: ["@e_1", "@e_1"] }),
      /acceptableTargets must be unique/,
    );
  });

  it("rejects targets that are absent, not clickable, hidden or disabled", () => {
    rejects(validFixture({ acceptableTargets: ["@e_9"] }), /not in the observation/);

    const observation = fixtureObservation({
      elements: [
        fixtureButton("@e_1", "Static", { capabilities: [] }),
        fixtureButton("@e_2", "Hidden", { visible: false }),
        fixtureButton("@e_3", "Disabled", { enabled: false }),
      ],
    });
    for (const target of ["@e_1", "@e_2", "@e_3"]) {
      rejects(
        validFixture({ observation, acceptableTargets: [target] }),
        /visible, enabled clickable/,
      );
    }
  });

  it("rejects duplicate observation refs", () => {
    rejects(
      validFixture({
        observation: fixtureObservation({
          elements: [
            fixtureButton("@e_1", "Save"),
            fixtureButton("@e_1", "Save again"),
          ],
        }),
      }),
      /refs must be unique/,
    );
  });

  it("rejects elements in frames the observation does not declare", () => {
    rejects(
      validFixture({
        observation: fixtureObservation({
          elements: [fixtureButton("@e_1", "Save", { frameId: "child-9" })],
        }),
      }),
      /frameId must exist/,
    );
  });

  it("rejects empty, duplicate or unknown tags", () => {
    rejects(validFixture({ tags: [] }), /tags/);
    rejects(validFixture({ tags: ["overlay", "overlay"] }), /tags/);
    rejects(validFixture({ tags: ["unknown" as never] }), /tags/);
  });

  it("requires ESCALATE whenever actionable coverage is incomplete", () => {
    for (const status of ["truncated", "partial", "unknown"] as const) {
      const observation = fixtureObservation({
        elements: [fixtureButton("@e_1", "Save")],
        actionableCoverage: { status, returned: 1 },
      });
      rejects(validFixture({ observation }), /must accept ESCALATE/);
      expect(() =>
        validateDecisionFixtures([
          validFixture({
            observation,
            acceptableOperations: ["CLICK", "ESCALATE"],
          }),
        ]),
      ).not.toThrow();
    }
  });
  it("accepts an intent exactly when tagged structured-intent", () => {
    const intent = { operation: "click" as const, target: { name: "Save" } };
    expect(() =>
      validateDecisionFixtures([
        validFixture({ intent, tags: ["structured-intent"] }),
      ]),
    ).not.toThrow();
    rejects(
      validFixture({ intent, tags: ["replacement"] }),
      /intent exactly when tagged structured-intent/,
    );
    rejects(
      validFixture({ tags: ["structured-intent"] }),
      /intent exactly when tagged structured-intent/,
    );
  });

  it("rejects an invalid intent", () => {
    rejects(
      validFixture({
        intent: { operation: "click", target: { name: "Sa\u200Bve" } },
        tags: ["structured-intent"],
      }),
      /intent must be a valid step intent/,
    );
  });

  it("derives the tab origin from the fixture url", () => {
    expect(fixtureObservation().tab.origin).toBe("https://fixture.test");
    expect(
      fixtureObservation({ url: "https://other.fixture.test:8443/path?q=1" }).tab.origin,
    ).toBe("https://other.fixture.test:8443");
  });
});
