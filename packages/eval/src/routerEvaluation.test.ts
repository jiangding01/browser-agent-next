import { describe, expect, it, vi } from "vitest";
import { routeStep, type StepIntent } from "@browser-agent-next/router";
import { observationOrderCandidateBuilder } from "./candidateBuilder.js";
import {
  validateDecisionFixtures,
  type DecisionFixture,
} from "./decisionFixture.js";
import { decisionFixtures } from "./decisionFixtures.js";
import {
  runDecisionEvaluation,
  type DecisionProvider,
  type DecisionProviderInput,
} from "./decisionHarness.js";
import {
  fixtureButton,
  fixtureObservation,
} from "./foundationFixtures.js";
import {
  escalateProvider,
  evaluateRouter,
  routedDecisionProvider,
} from "./routerEvaluation.js";
import {
  routerExpectations,
  routerFixtures,
} from "./routerFixtures.js";

const saveIntent: StepIntent = { operation: "click", target: { name: "Save" } };

function providerInput(
  candidateRefs: string[],
  intent: StepIntent | null = saveIntent,
): DecisionProviderInput {
  return {
    observation: fixtureObservation({ elements: [fixtureButton("@e_1", "Save")] }),
    microGoal: "Save the draft",
    candidates: { refs: candidateRefs, coverage: "complete" },
    ...(intent !== null ? { intent } : {}),
  };
}

describe("router fixture batch", () => {
  it("passes fixture validation and carries an intent on every fixture", () => {
    expect(() => validateDecisionFixtures(routerFixtures)).not.toThrow();
    expect(routerFixtures).toHaveLength(16);
    for (const fixture of routerFixtures) {
      expect(fixture.intent).toBeDefined();
      expect(fixture.tags).toContain("structured-intent");
    }
  });

  it("matches the expected route of every fixture exactly", () => {
    expect(Object.keys(routerExpectations).sort()).toEqual(
      routerFixtures.map((fixture) => fixture.name).sort(),
    );
    for (const fixture of routerFixtures) {
      expect(
        routeStep({ observation: fixture.observation, ...(fixture.intent ? { intent: fixture.intent } : {}) }),
        fixture.name,
      ).toEqual(routerExpectations[fixture.name]);
    }
  });
});

describe("evaluateRouter", () => {
  it("never resolves a wrong target on the router batch", () => {
    const report = evaluateRouter({ fixtures: routerFixtures });

    expect(report.fixtureCount).toBe(16);
    expect(report.intentCount).toBe(16);
    expect(report.resolvedWrong).toEqual([]);
    expect(report.resolved).toEqual({ numerator: 5, denominator: 16, rate: 5 / 16 });
    expect(report.resolvedCorrect).toEqual({ numerator: 5, denominator: 5, rate: 1 });
    expect(report.deferReasons).toEqual({
      ambiguous: 4,
      "target-disabled": 1,
      "target-occluded": 1,
      "coverage-incomplete": 3,
      "no-match": 2,
    });
    // intent-case-differs、intent-injection-suffix、intent-cross-origin-default。
    expect(report.missedClick).toBe(3);
  });

  it("reports null rates on the first batch, which carries no intent", () => {
    const report = evaluateRouter({ fixtures: decisionFixtures });

    expect(report.intentCount).toBe(0);
    expect(report.resolved.rate).toBeNull();
    expect(report.resolvedCorrect.denominator).toBe(0);
    expect(report.deferReasons).toEqual({});
    expect(report.missedClick).toBe(0);
    expect(report.fixtures.every((item) => item.result.route === "defer")).toBe(true);
  });

  it("lists a resolved fixture whose ground truth rejects the click", () => {
    const [first] = routerFixtures;
    const wrong: DecisionFixture = {
      ...structuredClone(first!),
      name: "intent-truth-says-escalate",
      acceptableOperations: ["ESCALATE"],
    };
    delete wrong.acceptableTargets;

    const report = evaluateRouter({ fixtures: [wrong] });
    expect(report.resolvedWrong).toEqual(["intent-truth-says-escalate"]);
    expect(report.resolvedCorrect).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });

  it("validates fixtures before running", () => {
    const [first] = routerFixtures;
    const broken = { ...structuredClone(first!), intent: { operation: "click" } } as unknown as DecisionFixture;
    expect(() => evaluateRouter({ fixtures: [broken] })).toThrow(/valid step intent/);
  });
});

describe("routedDecisionProvider", () => {
  it("clicks a resolved ref that is in the candidate set", async () => {
    const fallback = { name: "spy", decide: vi.fn(() => ({ operation: "ESCALATE" as const })) };
    const provider = routedDecisionProvider(fallback);

    expect(provider.name).toBe("deterministic-router+spy");
    expect(await provider.decide(providerInput(["@e_1"]))).toEqual({ operation: "CLICK", ref: "@e_1" });
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it("hands a resolved ref outside the candidate set to the fallback", async () => {
    const fallback = { name: "spy", decide: vi.fn(() => ({ operation: "ESCALATE" as const })) };
    const input = providerInput([]);

    expect(await routedDecisionProvider(fallback).decide(input)).toEqual({ operation: "ESCALATE" });
    expect(fallback.decide).toHaveBeenCalledWith(input);
  });

  it("hands a deferral to the fallback", async () => {
    const fallback = { name: "spy", decide: vi.fn(() => ({ operation: "HANDOFF_VERIFY" as const })) };

    expect(await routedDecisionProvider(fallback).decide(providerInput(["@e_1"], null))).toEqual({
      operation: "HANDOFF_VERIFY",
    });
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });

  it("produces no unsafe click through the harness on either batch", async () => {
    const report = await runDecisionEvaluation({
      fixtures: [...decisionFixtures, ...routerFixtures],
      builder: observationOrderCandidateBuilder(),
      provider: routedDecisionProvider(escalateProvider),
    });

    expect(report.provider).toBe("deterministic-router+escalate");
    expect(report.overall.decision.unsafeClick.numerator).toBe(0);
    expect(report.overall.decision.invalidCount).toBe(0);
    const clicks = report.fixtures.filter((outcome) => outcome.decision?.operation === "CLICK");
    expect(clicks.map((outcome) => outcome.name).sort()).toEqual([
      "intent-cross-origin-explicit",
      "intent-fullwidth-normalized",
      "intent-hidden-replacement",
      "intent-role-disambiguates",
      "intent-unique-exact",
    ]);
  });
});

describe("harness intent passing", () => {
  it("passes the frozen intent only for fixtures that carry one", async () => {
    const seen: Array<{ name: string; hasIntent: boolean; frozen: boolean }> = [];
    const recorder: DecisionProvider = {
      name: "recorder",
      decide(input) {
        seen.push({
          name: input.microGoal,
          hasIntent: "intent" in input,
          frozen: input.intent === undefined || Object.isFrozen(input.intent.target),
        });
        return { operation: "ESCALATE" };
      },
    };
    const [withIntent] = routerFixtures;
    const [withoutIntent] = decisionFixtures;

    await runDecisionEvaluation({
      fixtures: [
        { ...withIntent!, microGoal: "with" },
        { ...withoutIntent!, microGoal: "without" },
      ],
      builder: observationOrderCandidateBuilder(),
      provider: recorder,
    });

    expect(seen).toEqual([
      { name: "with", hasIntent: true, frozen: true },
      { name: "without", hasIntent: false, frozen: true },
    ]);
  });
});
