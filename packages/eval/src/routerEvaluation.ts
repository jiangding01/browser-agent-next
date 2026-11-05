import {
  routeStep,
  type DeferReason,
  type RouteResult,
} from "@browser-agent-next/router";
import { deepFreeze } from "./deepFreeze.js";
import {
  validateDecisionFixtures,
  type DecisionFixture,
} from "./decisionFixture.js";
import {
  rateMetric,
  type DecisionProvider,
  type RateMetric,
} from "./decisionHarness.js";

/** 恒返回 ESCALATE：代表“今天没有 Jev，交还调用方”。 */
export const escalateProvider: DecisionProvider = {
  name: "escalate",
  decide: () => ({ operation: "ESCALATE" }),
};

/**
 * 把 deterministic router 接成 harness 可评测的 provider。
 *
 * router resolve 且 ref 在本次候选集内 → CLICK；其余（defer，或 resolve 的 ref 不在候选集内）
 * 一律交给 fallback：builder 的漏召回不能被记成 router 的不安全点击（不变量 160）。
 */
export function routedDecisionProvider(
  fallback: DecisionProvider,
): DecisionProvider {
  return {
    name: "deterministic-router+" + fallback.name,
    decide(input) {
      const result = routeStep({
        observation: input.observation,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
      });
      if (
        result.route === "resolved" &&
        input.candidates.refs.includes(result.ref)
      ) {
        return { operation: "CLICK", ref: result.ref };
      }
      return fallback.decide(input);
    },
  };
}

export interface RouterFixtureResult {
  name: string;
  result: RouteResult;
}

export interface RouterEvaluationReport {
  router: "deterministic-router";
  fixtureCount: number;
  /** 带 intent 的 fixture 数；下列指标都只统计这些 fixture。 */
  intentCount: number;
  /**
   * 分母为 intentCount。fixture 是对抗集，其中不少本应 defer，
   * 这个比例只用作回归信号，不是 router 覆盖率或质量基准。
   */
  resolved: RateMetric;
  /** 分母为 resolve 数：resolve 的 ref 是可接受的 CLICK target。 */
  resolvedCorrect: RateMetric;
  /** resolve 了但 CLICK 不可接受或 ref 不在 acceptableTargets 中的 fixture 名。必须为空。 */
  resolvedWrong: string[];
  deferReasons: Partial<Record<DeferReason, number>>;
  /**
   * defer、CLICK 可接受且 ESCALATE 不可接受的 fixture 数：
   * 只有 router 的保守让任务无法以安全升级完成时才计入。
   * 它包含按设计就该 defer 的情形（如默认作用域外的跨源目标），解读时结合 deferReasons；
   * CLICK 与 ESCALATE 都可接受时的 defer 不计入。
   */
  missedClick: number;
  fixtures: RouterFixtureResult[];
}

/** 独立于 CandidateBuilder 的 router 报告（docs/DETERMINISTIC-ROUTER.md「Eval 接入」）。 */
export function evaluateRouter(input: {
  fixtures: readonly DecisionFixture[];
}): RouterEvaluationReport {
  const fixtures = deepFreeze(structuredClone([...input.fixtures]));
  validateDecisionFixtures(fixtures);

  const results: RouterFixtureResult[] = [];
  const resolvedWrong: string[] = [];
  const deferReasons: Partial<Record<DeferReason, number>> = {};
  let intentCount = 0;
  let resolvedCount = 0;
  let resolvedCorrect = 0;
  let missedClick = 0;

  for (const fixture of fixtures) {
    const result = routeStep({
      observation: fixture.observation,
      ...(fixture.intent !== undefined ? { intent: fixture.intent } : {}),
    });
    results.push({ name: fixture.name, result });
    if (fixture.intent === undefined) continue;

    intentCount += 1;
    const clickAcceptable = fixture.acceptableOperations.includes("CLICK");

    if (result.route === "resolved") {
      resolvedCount += 1;
      if (
        clickAcceptable &&
        (fixture.acceptableTargets ?? []).includes(result.ref)
      ) {
        resolvedCorrect += 1;
      } else {
        resolvedWrong.push(fixture.name);
      }
      continue;
    }

    deferReasons[result.reason] = (deferReasons[result.reason] ?? 0) + 1;
    if (clickAcceptable && !fixture.acceptableOperations.includes("ESCALATE")) {
      missedClick += 1;
    }
  }

  return {
    router: "deterministic-router",
    fixtureCount: fixtures.length,
    intentCount,
    resolved: rateMetric(resolvedCount, intentCount),
    resolvedCorrect: rateMetric(resolvedCorrect, resolvedCount),
    resolvedWrong,
    deferReasons,
    missedClick,
    fixtures: results,
  };
}
