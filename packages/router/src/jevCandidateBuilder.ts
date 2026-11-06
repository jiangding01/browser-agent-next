import type {
  BrowserObservation,
  ElementState,
} from "@browser-agent-next/core";
import {
  DEFAULT_MAX_CANDIDATES,
  checkedMaxCandidates,
  isClickCandidate,
  type CandidateBuilder,
  type CandidateSet,
} from "./candidateSet.js";
import { LEXICON_VERSION } from "./conceptLexicon.js";
import { unitsOf } from "./goalTerms.js";

export const JEV_CANDIDATE_BUILDER_NAME = "jev-relevance";

/** 字段权重：name > description > text（description 当前没有运行期数据源，保留给将来）。 */
const FIELD_WEIGHTS = [
  ["name", 3],
  ["description", 2],
  ["text", 1],
] as const;

/**
 * 候选与 goal 的相关度（docs/JEV-CANDIDATE-BUILDER.md「打分」）：
 * 每个 goal unit 只按命中它的最佳字段计一次，字段得分按 unit 数的平方根归一。
 * 只读 semantic 的 name / description / text，不读 value、role、frame 与 geometry（不变量 164）。
 */
export function relevanceScore(
  goalUnits: ReadonlySet<string>,
  element: ElementState,
): number {
  const unitsByText = new Map<string, Set<string>>();
  const fields = FIELD_WEIGHTS.flatMap(([field, weight]) => {
    const text = element.semantic[field];
    if (text === undefined) return [];
    // name 与 text 常常相同（都来自 textContent），只切分一次。
    let units = unitsByText.get(text);
    if (units === undefined) {
      units = unitsOf(text);
      unitsByText.set(text, units);
    }
    return units.size === 0 ? [] : [{ units, value: weight / Math.sqrt(units.size) }];
  });

  let score = 0;
  for (const unit of goalUnits) {
    let best = 0;
    for (const field of fields) {
      if (field.units.has(unit)) best = Math.max(best, field.value);
    }
    score += best;
  }
  // 量化掉浮点误差：数学上同分（如 3/√27 与 1/√3）必须按 observation 顺序（不变量 165）。
  return Math.round(score * 1e9) / 1e9;
}

/**
 * Jev 的确定性候选排序（不变量 163～165）：资格与参考实现完全相同，只重排与截断；
 * 分数降序、同分按 observation 顺序；没有任何命中时与参考实现输出相同。
 */
export function jevCandidateBuilder(
  options: { maxCandidates?: number } = {},
): CandidateBuilder {
  const maxCandidates = checkedMaxCandidates(
    options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  );

  return {
    name: JEV_CANDIDATE_BUILDER_NAME,
    build(observation: BrowserObservation, microGoal: string): CandidateSet {
      const goalUnits = unitsOf(microGoal);
      const scored = observation.elements
        .filter(isClickCandidate)
        .map((element, index) => ({
          ref: element.ref,
          index,
          score: relevanceScore(goalUnits, element),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      const kept = scored.slice(0, maxCandidates);
      const truncated = scored.length > maxCandidates;

      return {
        refs: kept.map((candidate) => candidate.ref),
        // 不变量 133：只会继承或降级为 truncated，绝不提升。
        coverage: truncated ? "truncated" : observation.coverage.actionable.status,
        totalKnown: scored.length,
        ranking: {
          builder: JEV_CANDIDATE_BUILDER_NAME,
          lexiconVersion: LEXICON_VERSION,
          scoredCount: kept.filter((candidate) => candidate.score > 0).length,
        },
      };
    },
  };
}
