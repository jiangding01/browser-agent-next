import type {
  BrowserObservation,
  CoverageStatus,
  Ref,
} from "@browser-agent-next/core";

export interface CandidateSet {
  /** 有序候选；Recall@K 取前 K 个。 */
  refs: Ref[];
  coverage: CoverageStatus;
  totalKnown?: number;
}

export interface CandidateBuilder {
  readonly name: string;
  build(observation: BrowserObservation, microGoal: string): CandidateSet;
}

export interface ObservationOrderCandidateBuilderOptions {
  maxCandidates?: number;
}

export const DEFAULT_MAX_CANDIDATES = 50;
export const MAX_CANDIDATES_LIMIT = 500;

/**
 * 参考 CandidateBuilder：模型今天直接看到的 action space。
 *
 * 只保留可见、启用、带 click capability 的元素并保持 observation 顺序；
 * 不按 geometry / hitTestable 过滤（遮挡判断属于 decision 与 Strict preflight）。
 * coverage 只会继承或降级为 truncated，绝不提升（不变量 133）。
 */
export function observationOrderCandidateBuilder(
  options: ObservationOrderCandidateBuilderOptions = {},
): CandidateBuilder {
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (
    !Number.isInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > MAX_CANDIDATES_LIMIT
  ) {
    throw new Error(
      "maxCandidates must be an integer between 1 and " + MAX_CANDIDATES_LIMIT,
    );
  }

  return {
    name: "observation-order",
    build(observation) {
      const eligible = observation.elements
        .filter(
          (element) =>
            element.state.visible &&
            element.state.enabled &&
            element.capabilities.some((capability) => capability.kind === "click"),
        )
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
