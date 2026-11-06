import {
  DEFAULT_MAX_CANDIDATES,
  checkedMaxCandidates,
  isClickCandidate,
  type CandidateBuilder,
} from "@browser-agent-next/router";

// 候选类型与唯一的 CLICK 候选资格定义在 router（决策层，运行期可复用）；这里再导出，保持既有导入路径。
export {
  DEFAULT_MAX_CANDIDATES,
  MAX_CANDIDATES_LIMIT,
  isClickCandidate,
  type CandidateBuilder,
  type CandidateRanking,
  type CandidateSet,
} from "@browser-agent-next/router";

export interface ObservationOrderCandidateBuilderOptions {
  maxCandidates?: number;
}

/**
 * 参考 CandidateBuilder：模型今天直接看到的 action space。
 *
 * 资格与所有 builder 相同（isClickCandidate，不变量 163），保持 observation 顺序；
 * coverage 只会继承或降级为 truncated，绝不提升（不变量 133）。
 */
export function observationOrderCandidateBuilder(
  options: ObservationOrderCandidateBuilderOptions = {},
): CandidateBuilder {
  const maxCandidates = checkedMaxCandidates(
    options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  );

  return {
    name: "observation-order",
    build(observation) {
      const eligible = observation.elements
        .filter(isClickCandidate)
        .map((element) => element.ref);

      const truncated = eligible.length > maxCandidates;

      return {
        refs: eligible.slice(0, maxCandidates),
        coverage: truncated
          ? "truncated"
          : observation.coverage.actionable.status,
        totalKnown: eligible.length,
      };
    },
  };
}
