import { describe, expect, it } from "vitest";
import {
  observationOrderCandidateBuilder,
  type CandidateBuilder,
  type CandidateSet,
} from "./candidateBuilder.js";
import type { DecisionFixture } from "./decisionFixture.js";
import { decisionFixtures } from "./decisionFixtures.js";
import {
  runDecisionEvaluation,
  type Decision,
  type DecisionProvider,
} from "./decisionHarness.js";
import {
  fixtureButton,
  fixtureObservation,
} from "./foundationFixtures.js";

const builder = observationOrderCandidateBuilder();

/** 手算用的小 fixture 集：两个 CLICK fixture、两个非 CLICK fixture。 */
const smallSet: DecisionFixture[] = [
  {
    name: "click-a",
    microGoal: "Cancel the edit",
    observation: fixtureObservation({
      elements: [
        fixtureButton("@e_1", "Save"),
        fixtureButton("@e_2", "Cancel"),
      ],
    }),
    acceptableOperations: ["CLICK"],
    acceptableTargets: ["@e_2"],
    tags: ["replacement"],
  },
  {
    name: "click-b",
    microGoal: "Go",
    observation: fixtureObservation({
      elements: [fixtureButton("@e_1", "Go")],
    }),
    acceptableOperations: ["CLICK", "ESCALATE"],
    acceptableTargets: ["@e_1"],
    tags: ["overlay"],
  },
  {
    name: "escalate-c",
    microGoal: "Submit",
    observation: fixtureObservation({
      elements: [fixtureButton("@e_1", "Back")],
    }),
    acceptableOperations: ["ESCALATE"],
    tags: ["disabled"],
  },
  {
    name: "form-d",
    microGoal: "Fill the form",
    observation: fixtureObservation({
      elements: [
        fixtureButton("@f_1", "Street", {
          kind: "field",
          role: "textbox",
          capabilities: [{ kind: "setValue" }],
        }),
      ],
    }),
    acceptableOperations: ["HANDOFF_FORM"],
    tags: ["form-handoff"],
  },
];

function provider(
  name: string,
  decide: DecisionProvider["decide"],
): DecisionProvider {
  return { name, decide };
}

/** 按 fixture 顺序回放预设决策；harness 串行运行，因此顺序确定。 */
function sequenceProvider(decisions: readonly unknown[]): DecisionProvider {
  let index = 0;
  return provider("sequence", () => decisions[index++] as Decision);
}

function oracleFor(fixtures: readonly DecisionFixture[]): DecisionProvider {
  return sequenceProvider(
    fixtures.map((fixture) =>
      fixture.acceptableOperations.includes("CLICK")
        ? { operation: "CLICK", ref: fixture.acceptableTargets![0] }
        : { operation: fixture.acceptableOperations[0] },
    ),
  );
}

const alwaysEscalate = provider("always-escalate", () => ({
  operation: "ESCALATE",
}));

const firstCandidate = provider("first-candidate", ({ candidates }) => {
  const ref = candidates.refs[0];
  return ref === undefined
    ? { operation: "ESCALATE" }
    : { operation: "CLICK", ref };
});

function droppingBuilder(dropped: readonly string[]): CandidateBuilder {
  return {
    name: "dropping",
    build(observation, microGoal) {
      const base = builder.build(observation, microGoal);
      const refs = base.refs.filter((ref) => !dropped.includes(ref));
      return { refs, coverage: base.coverage, totalKnown: refs.length };
    },
  };
}

describe("runDecisionEvaluation", () => {
  it("scores an oracle provider on the shipped fixtures as fully correct and safe", async () => {
    const report = await runDecisionEvaluation({
      fixtures: decisionFixtures,
      builder,
      provider: oracleFor(decisionFixtures),
    });

    expect(report.overall.decision.conditionalAccuracy.rate).toBe(1);
    expect(report.overall.decision.unsafeClick.rate).toBe(0);
    expect(report.overall.candidate.missCount).toBe(0);
    expect(report.overall.candidate.recallAtK.all?.rate).toBe(1);
    expect(report.fixtures.every((outcome) => outcome.attribution === "ok")).toBe(true);
    expect(report.fixtures.map((outcome) => outcome.name)).toEqual(
      decisionFixtures.map((fixture) => fixture.name),
    );
  });

  it("matches hand-computed metrics for an always-ESCALATE provider", async () => {
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: alwaysEscalate,
    });

    expect(report.overall.decision.conditionalAccuracy).toEqual({
      numerator: 2,
      denominator: 4,
      rate: 0.5,
    });
    expect(report.overall.decision.click.rate).toBe(0.5);
    expect(report.overall.decision.nonClick.rate).toBe(0.5);
    expect(report.overall.decision.unsafeClick.rate).toBe(0);
    expect(report.fixtures.map((outcome) => outcome.attribution)).toEqual([
      "decision-wrong",
      "ok",
      "ok",
      "decision-wrong",
    ]);
  });

  it("matches hand-computed recall and safety for a first-candidate provider", async () => {
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: firstCandidate,
      ks: [1, 3],
    });

    expect(report.ks).toEqual([1, 3]);
    expect(report.overall.candidate.recallAtK).toEqual({
      "1": { numerator: 1, denominator: 2, rate: 0.5 },
      "3": { numerator: 2, denominator: 2, rate: 1 },
      all: { numerator: 2, denominator: 2, rate: 1 },
    });
    expect(report.fixtures.map((outcome) => outcome.targetRank)).toEqual([
      2,
      1,
      null,
      null,
    ]);
    // click-a 点错、escalate-c 在不可点击的 fixture 上点击：都计入 unsafe。
    expect(report.overall.decision.unsafeClick).toEqual({
      numerator: 2,
      denominator: 4,
      rate: 0.5,
    });
    expect(report.overall.decision.conditionalAccuracy.rate).toBe(0.25);
    expect(report.overall.candidate.completeActionSpace.rate).toBe(1);
  });

  it("treats a CLICK outside the candidate set as invalid and unsafe even when acceptable", async () => {
    const fixture: DecisionFixture = {
      name: "two-targets",
      microGoal: "Open either report",
      observation: fixtureObservation({
        elements: [
          fixtureButton("@e_1", "Home"),
          fixtureButton("@e_2", "Report A"),
          fixtureButton("@e_3", "Report B"),
        ],
      }),
      acceptableOperations: ["CLICK"],
      acceptableTargets: ["@e_2", "@e_3"],
      tags: ["duplicate-name"],
    };

    const report = await runDecisionEvaluation({
      fixtures: [fixture],
      builder: droppingBuilder(["@e_3"]),
      provider: sequenceProvider([{ operation: "CLICK", ref: "@e_3" }]),
    });

    expect(report.fixtures[0]).toMatchObject({
      valid: false,
      correct: false,
      unsafeClick: true,
      attribution: "decision-invalid",
      targetRank: 2,
    });
    expect(report.overall.decision.conditionalAccuracy.rate).toBe(0);
    expect(report.overall.decision.invalidCount).toBe(1);
  });

  it("attributes missing targets to the candidate layer and keeps them out of conditional accuracy", async () => {
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder: droppingBuilder(["@e_1", "@e_2"]),
      provider: sequenceProvider([
        { operation: "CLICK", ref: "@e_2" },
        { operation: "ESCALATE" },
        { operation: "ESCALATE" },
        { operation: "HANDOFF_FORM" },
      ]),
    });

    expect(report.overall.candidate.missCount).toBe(2);
    expect(report.overall.candidate.recallAtK.all?.rate).toBe(0);
    expect(report.fixtures.map((outcome) => outcome.attribution)).toEqual([
      "candidate-miss",
      "ok",
      "ok",
      "ok",
    ]);
    expect(report.fixtures[0]?.unsafeClick).toBe(true);
    // 只剩两个非 CLICK fixture 进入分母。
    expect(report.overall.decision.conditionalAccuracy).toEqual({
      numerator: 2,
      denominator: 2,
      rate: 1,
    });
    expect(report.overall.decision.click.rate).toBeNull();
    expect(report.overall.decision.safeFallback).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    // click-a 的候选外 CLICK 归因 candidate-miss，但仍计入非法决策数。
    expect(report.overall.decision.invalidCount).toBe(1);
  });

  it("records provider errors and keeps evaluating the remaining fixtures", async () => {
    let calls = 0;
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: provider("flaky", () => {
        calls += 1;
        if (calls === 2) throw new Error("provider exploded");
        return { operation: "ESCALATE" };
      }),
    });

    expect(calls).toBe(4);
    expect(report.fixtures[1]).toMatchObject({
      attribution: "provider-error",
      decision: null,
      correct: false,
      unsafeClick: false,
    });
    expect(report.overall.decision.providerErrorCount).toBe(1);
  });

  it("records decisions whose properties throw as provider errors", async () => {
    const throwingGetter = {
      get operation(): string {
        throw new Error("getter exploded");
      },
    };
    const throwingKeys = new Proxy(
      { operation: "ESCALATE" },
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: sequenceProvider([
        throwingGetter,
        throwingKeys,
        { operation: "ESCALATE" },
        { operation: "HANDOFF_FORM" },
      ]),
    });

    expect(report.fixtures.map((outcome) => outcome.attribution)).toEqual([
      "provider-error",
      "provider-error",
      "ok",
      "ok",
    ]);
  });

  it("scores against the candidate refs fixed before the provider ran", async () => {
    const report = await runDecisionEvaluation({
      fixtures: [smallSet[0]!],
      builder: droppingBuilder(["@e_2"]),
      provider: provider("injecting", ({ candidates }) => {
        try {
          (candidates.refs as string[]).unshift("@e_2");
        } catch {
          // 冻结的候选集拒绝修改；无论修改是否成功，打分都不能受影响。
        }
        return { operation: "CLICK", ref: "@e_2" };
      }),
    });

    expect(report.fixtures[0]).toMatchObject({
      targetRank: null,
      valid: false,
      correct: false,
      unsafeClick: true,
      attribution: "candidate-miss",
    });
    expect(report.overall.candidate.recallAtK["1"]?.rate).toBe(0);
  });

  it("scores against a fixture snapshot taken before the run", async () => {
    const callerFixtures = structuredClone(smallSet);
    let first = true;
    const rewriting = provider("rewriting", () => {
      if (first) {
        first = false;
        for (const fixture of callerFixtures) {
          fixture.acceptableOperations.push("ESCALATE");
        }
      }
      return { operation: "ESCALATE" };
    });

    const report = await runDecisionEvaluation({
      fixtures: callerFixtures,
      builder,
      provider: rewriting,
    });

    expect(report.overall.decision.conditionalAccuracy.rate).toBe(0.5);
    // 快照是克隆：调用方的 fixture 不会被冻结。
    expect(Object.isFrozen(smallSet[0]!.observation)).toBe(false);
    expect(Object.isFrozen(decisionFixtures[0]!.observation)).toBe(true);
  });

  it("rejects structurally invalid decisions", async () => {
    const invalid: unknown[] = [
      { operation: "CLICK", ref: "@e_2", confidence: 1.5 },
      { operation: "ESCALATE", confidence: Number.NaN },
      { operation: "ESCALATE", ref: "@e_1" },
      { operation: "TYPE" },
    ];
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: sequenceProvider(invalid),
    });

    expect(report.fixtures.map((outcome) => outcome.valid)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(report.fixtures[0]?.unsafeClick).toBe(true);
    expect(report.fixtures[3]?.decision).toBeNull();

    const nonStringRef = await runDecisionEvaluation({
      fixtures: [smallSet[1]!],
      builder,
      provider: sequenceProvider([{ operation: "CLICK", ref: 42 }]),
    });
    expect(nonStringRef.fixtures[0]).toMatchObject({
      decision: null,
      valid: false,
      unsafeClick: true,
    });
  });

  it("keeps valid confidence values in the decision copy", async () => {
    const report = await runDecisionEvaluation({
      fixtures: [smallSet[2]!],
      builder,
      provider: sequenceProvider([{ operation: "ESCALATE", confidence: 0.4 }]),
    });

    expect(report.fixtures[0]?.decision).toEqual({
      operation: "ESCALATE",
      confidence: 0.4,
    });
  });

  it("returns null rates for empty denominators", async () => {
    const report = await runDecisionEvaluation({
      fixtures: [smallSet[2]!, smallSet[3]!],
      builder,
      provider: alwaysEscalate,
    });

    expect(report.overall.candidate.recallAtK["1"]).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    });
    expect(report.overall.decision.click.rate).toBeNull();
    expect(report.overall.decision.safeFallback.rate).toBeNull();
  });

  it("isolates fixtures from provider mutation and is deterministic", async () => {
    const before = structuredClone(smallSet);
    const mutating = provider("mutating", ({ observation, candidates }) => {
      (observation.elements as unknown[]).push({ ref: "@e_99" });
      (candidates.refs as string[]).push("@e_99");
      return { operation: "ESCALATE" };
    });

    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: mutating,
    });

    expect(report.overall.decision.providerErrorCount).toBe(4);
    expect(smallSet).toEqual(before);

    const first = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: firstCandidate,
    });
    const second = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: firstCandidate,
    });
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("does not call the provider when fixture validation fails", async () => {
    let calls = 0;
    await expect(
      runDecisionEvaluation({
        fixtures: [smallSet[0]!, { ...smallSet[1]!, acceptableTargets: [] }],
        builder,
        provider: provider("counting", () => {
          calls += 1;
          return { operation: "ESCALATE" };
        }),
      }),
    ).rejects.toThrow(/exactly when CLICK/);
    expect(calls).toBe(0);
  });

  it("rejects invalid ks before calling the provider", async () => {
    let calls = 0;
    const counting = provider("counting", () => {
      calls += 1;
      return { operation: "ESCALATE" };
    });
    for (const ks of [[], [0], [1, 1], [501], [1.5]]) {
      await expect(
        runDecisionEvaluation({
          fixtures: smallSet,
          builder,
          provider: counting,
          ks,
        }),
      ).rejects.toThrow(/ks must be/);
    }
    expect(calls).toBe(0);
  });

  it("rejects invalid builder output with the fixture name", async () => {
    const invalidSets: Array<(observation: never) => CandidateSet> = [
      () => ({ refs: ["@e_1", "@e_1"], coverage: "complete" }),
      () => ({ refs: ["@e_404"], coverage: "complete" }),
      () => ({ refs: ["@e_1"], coverage: "complete", totalKnown: 0 }),
      () => ({ refs: ["@e_1"], coverage: "complete", totalKnown: 1.5 }),
      () => ({ refs: ["@e_1"], coverage: "bogus" as never }),
      () => ({ refs: [1 as never], coverage: "complete" }),
      () => null as never,
      () => ({ refs: ["@e_1"], coverage: "complete", extra: () => 1 }) as never,
    ];

    for (const build of invalidSets) {
      await expect(
        runDecisionEvaluation({
          fixtures: [smallSet[1]!],
          builder: { name: "broken", build },
          provider: alwaysEscalate,
        }),
      ).rejects.toThrow(/builder "broken" for fixture "click-b"/);
    }

    const truncatedFixture = decisionFixtures.find(
      (fixture) => fixture.name === "truncated-target-present",
    )!;
    await expect(
      runDecisionEvaluation({
        fixtures: [truncatedFixture],
        builder: {
          name: "upgrading",
          build: (observation) => ({
            refs: observation.elements.map((element) => element.ref),
            coverage: "complete",
          }),
        },
        provider: alwaysEscalate,
      }),
    ).rejects.toThrow(/must not be upgraded/);

    // getter 只在快照时读取一次：校验与报告看到同一个 coverage。
    let reads = 0;
    const flipping = await runDecisionEvaluation({
      fixtures: [truncatedFixture],
      builder: {
        name: "flipping",
        build: (observation) => ({
          refs: observation.elements.map((element) => element.ref),
          get coverage(): "truncated" | "complete" {
            reads += 1;
            return reads === 1 ? "truncated" : "complete";
          },
        }),
      },
      provider: alwaysEscalate,
    });
    expect(flipping.fixtures[0]?.candidateCoverage).toBe("truncated");
  });

  it("reports per-tag metrics only for tags present in the fixture set", async () => {
    const report = await runDecisionEvaluation({
      fixtures: smallSet,
      builder,
      provider: alwaysEscalate,
    });

    expect(Object.keys(report.byTag)).toEqual([
      "replacement",
      "overlay",
      "disabled",
      "form-handoff",
    ]);
    expect(report.byTag.overlay?.decision.conditionalAccuracy.rate).toBe(1);
    expect(report.byTag.replacement?.decision.conditionalAccuracy.rate).toBe(0);
  });
});
