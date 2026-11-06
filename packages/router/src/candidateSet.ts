import type {
  BrowserObservation,
  CoverageStatus,
  ElementState,
  Ref,
} from "@browser-agent-next/core";

/** 排序型 CandidateBuilder 附带的排序说明（docs/JEV-CANDIDATE-BUILDER.md「排序说明」）。 */
export interface CandidateRanking {
  builder: string;
  /** 概念词表与停用词表的固定版本；词表改动必须同时改版本，保证 replay 可复现。 */
  lexiconVersion: string;
  /**
   * 截断后候选中分数大于 0 的个数（都排在最前面）；其余只是按 observation 顺序的填充。
   * 不是置信度（不变量 164）。
   */
  scoredCount: number;
}

export interface CandidateSet {
  /** 有序候选；Recall@K 取前 K 个。 */
  refs: Ref[];
  coverage: CoverageStatus;
  totalKnown?: number;
  ranking?: CandidateRanking;
}

export interface CandidateBuilder {
  readonly name: string;
  build(observation: BrowserObservation, microGoal: string): CandidateSet;
}

export const DEFAULT_MAX_CANDIDATES = 50;
export const MAX_CANDIDATES_LIMIT = 500;

/**
 * 全仓唯一的 CLICK 候选资格定义（不变量 163）：可见、启用、带 click capability。
 * 不按 geometry / hitTestable 过滤：遮挡判断属于 decision 与 Strict preflight。
 */
export function isClickCandidate(element: ElementState): boolean {
  return (
    element.state.visible &&
    element.state.enabled &&
    element.capabilities.some((capability) => capability.kind === "click")
  );
}

/** 校验并返回 maxCandidates（1..MAX_CANDIDATES_LIMIT 的整数）。 */
export function checkedMaxCandidates(maxCandidates: number): number {
  if (
    !Number.isInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > MAX_CANDIDATES_LIMIT
  ) {
    throw new Error(
      "maxCandidates must be an integer between 1 and " + MAX_CANDIDATES_LIMIT,
    );
  }
  return maxCandidates;
}
