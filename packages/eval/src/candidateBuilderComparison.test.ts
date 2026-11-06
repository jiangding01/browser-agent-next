import { describe, expect, it } from "vitest";
import { jevCandidateBuilder } from "@browser-agent-next/router";
import {
  MAX_CANDIDATES_LIMIT,
  observationOrderCandidateBuilder,
  type CandidateBuilder,
} from "./candidateBuilder.js";
import { candidateFixtures } from "./candidateFixtures.js";
import { validateDecisionFixtures, type DecisionFixture } from "./decisionFixture.js";
import { decisionFixtures } from "./decisionFixtures.js";
import { runDecisionEvaluation } from "./decisionHarness.js";
import { escalateProvider } from "./routerEvaluation.js";
import { routerFixtures } from "./routerFixtures.js";

const allBatches = [...decisionFixtures, ...routerFixtures, ...candidateFixtures];

async function ranks(builder: CandidateBuilder, fixtures: readonly DecisionFixture[]) {
  const report = await runDecisionEvaluation({ fixtures, builder, provider: escalateProvider });
  return {
    report,
    rank: Object.fromEntries(report.fixtures.map((outcome) => [outcome.name, outcome.targetRank])),
  };
}

describe("candidate ranking batch", () => {
  it("passes fixture validation and is fully tagged", () => {
    expect(() => validateDecisionFixtures(candidateFixtures)).not.toThrow();
    expect(candidateFixtures).toHaveLength(14);
    expect(candidateFixtures.every((fixture) => fixture.tags.includes("candidate-ranking"))).toBe(true);
  });
});

describe("jev vs observation-order candidate builders", () => {
  it("only reorders: at a cap above every page, jev returns a permutation with identical coverage", () => {
    const jev = jevCandidateBuilder({ maxCandidates: MAX_CANDIDATES_LIMIT });
    const base = observationOrderCandidateBuilder({ maxCandidates: MAX_CANDIDATES_LIMIT });
    for (const fixture of allBatches) {
      const a = jev.build(fixture.observation, fixture.microGoal);
      const b = base.build(fixture.observation, fixture.microGoal);
      expect([...a.refs].sort(), fixture.name).toEqual([...b.refs].sort());
      expect(a.coverage, fixture.name).toBe(b.coverage);
      expect(a.totalKnown, fixture.name).toBe(b.totalKnown);
    }
  });

  it("reports the documented target ranks on the ranking batch at a cap of 20", async () => {
    const jev = await ranks(jevCandidateBuilder({ maxCandidates: 20 }), candidateFixtures);
    const base = await ranks(observationOrderCandidateBuilder({ maxCandidates: 20 }), candidateFixtures);

    expect(jev.rank).toEqual({
      "ranking-deep-target": 1,
      "ranking-generic-verb": 1,
      "ranking-lexicon-sign-out": 1,
      "ranking-cjk-goal-sign-out": 1,
      "ranking-view-details-cjk": 1,
      "ranking-plural": 1,
      "ranking-description": 1,
      "ranking-number": 1,
      "ranking-cjk-both": 1,
      "ranking-no-overlap": 3,
      "ranking-decoy-flood": 1,
      // 已知残余风险：复述 goal 的诱饵排在真正的 Settings 之前。
      "ranking-echo-decoy": 2,
      "ranking-cjk-stopword": 1,
      // 已知固有代价：部分命中的元素把 0 分的真目标挤出上限。
      "ranking-partial-overlap-pushout": null,
    });
    expect(base.rank).toEqual({
      "ranking-deep-target": null,
      "ranking-generic-verb": 2,
      "ranking-lexicon-sign-out": 4,
      "ranking-cjk-goal-sign-out": 2,
      "ranking-view-details-cjk": 2,
      "ranking-plural": 2,
      "ranking-description": 2,
      "ranking-number": 3,
      "ranking-cjk-both": 2,
      "ranking-no-overlap": 3,
      "ranking-decoy-flood": null,
      "ranking-echo-decoy": 2,
      "ranking-cjk-stopword": 2,
      "ranking-partial-overlap-pushout": 2,
    });
    expect(jev.report.overall.candidate.missCount).toBe(1);
    expect(base.report.overall.candidate.missCount).toBe(2);
  });

  it("exposes where the ranking signal ends", () => {
    const jev = jevCandidateBuilder({ maxCandidates: 20 });
    const byName = new Map(candidateFixtures.map((fixture) => [fixture.name, fixture]));
    const scored = (name: string) => {
      const fixture = byName.get(name)!;
      return jev.build(fixture.observation, fixture.microGoal).ranking?.scoredCount;
    };
    expect(scored("ranking-partial-overlap-pushout")).toBe(20);
    expect(scored("ranking-no-overlap")).toBe(0);
    expect(scored("ranking-lexicon-sign-out")).toBe(1);
    expect(observationOrderCandidateBuilder().build(byName.get("ranking-number")!.observation, "x").ranking)
      .toBeUndefined();
  });

  it("ranks the named first-batch fixtures first and never worsens any earlier CLICK fixture", async () => {
    const earlier = [...decisionFixtures, ...routerFixtures];
    const jev = await ranks(jevCandidateBuilder(), earlier);
    const base = await ranks(observationOrderCandidateBuilder(), earlier);

    for (const name of [
      "prompt-injection-label",
      "cjk-goal-latin-label",
      "latin-goal-cjk-label",
      "destructive-neighbor",
    ]) {
      expect(jev.rank[name], name).toBe(1);
    }
    for (const [name, baseRank] of Object.entries(base.rank)) {
      if (baseRank === null) continue;
      expect(jev.rank[name], name).not.toBeNull();
      expect(jev.rank[name]!, name).toBeLessThanOrEqual(baseRank);
    }
  });
});
