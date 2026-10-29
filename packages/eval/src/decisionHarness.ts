import type {
  BrowserObservation,
  CoverageStatus,
  Ref,
} from "@browser-agent-next/core";
import type {
  CandidateBuilder,
  CandidateSet,
} from "./candidateBuilder.js";
import {
  DECISION_OPERATIONS,
  FIXTURE_TAGS,
  validateDecisionFixtures,
  type DecisionFixture,
  type DecisionOperation,
  type FixtureTag,
} from "./decisionFixture.js";

export type Decision =
  | { operation: "CLICK"; ref: Ref; confidence?: number }
  | {
      operation: Exclude<DecisionOperation, "CLICK">;
      confidence?: number;
    };

export interface DecisionProviderInput {
  observation: BrowserObservation;
  microGoal: string;
  candidates: CandidateSet;
}

export interface DecisionProvider {
  readonly name: string;
  decide(input: DecisionProviderInput): Decision | Promise<Decision>;
}

/** 按“第一个失败的层”归因，见 docs/TRACE-EVAL-FOUNDATION.md。 */
export type FixtureAttribution =
  | "ok"
  | "candidate-miss"
  | "decision-invalid"
  | "decision-wrong"
  | "provider-error";

export interface FixtureOutcome {
  name: string;
  tags: FixtureTag[];
  candidateCount: number;
  candidateCoverage: CoverageStatus;
  /** 第一个可接受 target 在候选中的 1-based 位置；CLICK 不可接受或未包含时为 null。 */
  targetRank: number | null;
  /** 结构合法时的决策副本；provider 抛错或结构非法时为 null。 */
  decision: Decision | null;
  valid: boolean;
  correct: boolean;
  unsafeClick: boolean;
  attribution: FixtureAttribution;
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  /** 分母为 0 时为 null，不返回 0 或 NaN。 */
  rate: number | null;
}

export interface DecisionMetrics {
  fixtureCount: number;
  candidate: {
    /** key 为 K 的十进制字符串，另有 "all" 表示整个候选集。 */
    recallAtK: Record<string, RateMetric>;
    completeActionSpace: RateMetric;
    missCount: number;
  };
  decision: {
    /** 分母：候选包含 acceptable target 的 CLICK fixture ∪ 非 CLICK fixture（不变量 131）。 */
    conditionalAccuracy: RateMetric;
    click: RateMetric;
    nonClick: RateMetric;
    /** candidate miss 的 fixture 中 decision 仍然正确（选择了可接受的升级 / handoff）的比例。 */
    safeFallback: RateMetric;
    unsafeClick: RateMetric;
    invalidCount: number;
    providerErrorCount: number;
  };
}

export interface DecisionEvaluationReport {
  builder: string;
  provider: string;
  ks: number[];
  overall: DecisionMetrics;
  byTag: Partial<Record<FixtureTag, DecisionMetrics>>;
  fixtures: FixtureOutcome[];
}

export interface RunDecisionEvaluationInput {
  fixtures: readonly DecisionFixture[];
  builder: CandidateBuilder;
  provider: DecisionProvider;
  ks?: readonly number[];
}

export const DEFAULT_RECALL_KS = [1, 3, 5, 10] as const;
const MAX_K = 500;

const COVERAGE_STATUSES: readonly CoverageStatus[] = [
  "complete",
  "truncated",
  "partial",
  "unknown",
];

interface FixtureRecord {
  outcome: FixtureOutcome;
  clickFixture: boolean;
  included: boolean;
  candidateRefs: Ref[];
  targets: Ref[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateKs(ks: readonly number[]): number[] {
  if (
    ks.length === 0 ||
    new Set(ks).size !== ks.length ||
    ks.some((k) => !Number.isInteger(k) || k < 1 || k > MAX_K)
  ) {
    throw new Error(
      "ks must be a non-empty set of integers between 1 and " + MAX_K,
    );
  }
  return [...ks];
}

/**
 * builder 是被测的确定性代码：输出不合法属于 builder bug，直接失败，
 * 不能进入打分（重复 ref 或提升 coverage 会虚高 Recall）。
 */
function validateCandidateSet(
  candidates: CandidateSet,
  observation: BrowserObservation,
  builder: string,
  fixture: string,
): void {
  const fail = (message: string): never => {
    throw new Error(
      "invalid candidate set from builder " +
        JSON.stringify(builder) +
        " for fixture " +
        JSON.stringify(fixture) +
        ": " +
        message,
    );
  };

  if (
    !Array.isArray(candidates.refs) ||
    candidates.refs.some((ref) => typeof ref !== "string")
  ) {
    fail("refs must be an array of strings");
  }
  if (new Set(candidates.refs).size !== candidates.refs.length) {
    fail("refs must be unique");
  }
  const known = new Set(observation.elements.map((element) => element.ref));
  if (candidates.refs.some((ref) => !known.has(ref))) {
    fail("refs must exist in the observation");
  }
  if (!COVERAGE_STATUSES.includes(candidates.coverage)) {
    fail("coverage must be a known coverage status");
  }
  // 不变量 133：候选集不能比 observation 更完整。
  if (
    observation.coverage.actionable.status !== "complete" &&
    candidates.coverage === "complete"
  ) {
    fail("coverage must not be upgraded beyond the observation coverage");
  }
  if (
    candidates.totalKnown !== undefined &&
    (!Number.isInteger(candidates.totalKnown) ||
      candidates.totalKnown < candidates.refs.length)
  ) {
    fail("totalKnown must be an integer no smaller than refs.length");
  }
}

/**
 * provider 返回值来自被测代码，运行期不信任其类型：
 * 只接受 exact-key、已知 operation、CLICK 必须带候选集内 ref、confidence ∈ [0, 1]。
 */
function sanitizeDecision(
  raw: unknown,
  candidateRefs: readonly Ref[],
): { decision: Decision | null; valid: boolean; rawClick: boolean } {
  if (raw === null || typeof raw !== "object") {
    return { decision: null, valid: false, rawClick: false };
  }

  const record = raw as Record<string, unknown>;
  const operation = record.operation;
  const rawClick = operation === "CLICK";

  if (
    typeof operation !== "string" ||
    !(DECISION_OPERATIONS as readonly string[]).includes(operation)
  ) {
    return { decision: null, valid: false, rawClick };
  }

  const allowedKeys = rawClick
    ? ["operation", "ref", "confidence"]
    : ["operation", "confidence"];
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    return { decision: null, valid: false, rawClick };
  }

  const confidence = record.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    return { decision: null, valid: false, rawClick };
  }
  const confidenceField =
    confidence === undefined ? {} : { confidence };

  if (rawClick) {
    const ref = record.ref;
    if (typeof ref !== "string") {
      return { decision: null, valid: false, rawClick };
    }
    const decision: Decision = { operation: "CLICK", ref, ...confidenceField };
    // 不变量 132：候选集外的 ref 即使 acceptable 也不合法。
    return {
      decision,
      valid: candidateRefs.includes(ref),
      rawClick,
    };
  }

  return {
    decision: {
      operation: operation as Exclude<DecisionOperation, "CLICK">,
      ...confidenceField,
    },
    valid: true,
    rawClick,
  };
}

function rate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
}

function countWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function summarize(
  records: readonly FixtureRecord[],
  ks: readonly number[],
): DecisionMetrics {
  const click = records.filter((record) => record.clickFixture);
  const nonClick = records.filter((record) => !record.clickFixture);
  const included = click.filter((record) => record.included);
  const missed = click.filter((record) => !record.included);
  const eligible = [...included, ...nonClick];
  const correct = (record: FixtureRecord) => record.outcome.correct;

  const recallAtK: Record<string, RateMetric> = {};
  for (const k of ks) {
    recallAtK[String(k)] = rate(
      countWhere(click, (record) =>
        record.candidateRefs
          .slice(0, k)
          .some((ref) => record.targets.includes(ref)),
      ),
      click.length,
    );
  }
  recallAtK.all = rate(included.length, click.length);

  return {
    fixtureCount: records.length,
    candidate: {
      recallAtK,
      completeActionSpace: rate(
        countWhere(
          records,
          (record) => record.outcome.candidateCoverage === "complete",
        ),
        records.length,
      ),
      missCount: missed.length,
    },
    decision: {
      conditionalAccuracy: rate(countWhere(eligible, correct), eligible.length),
      click: rate(countWhere(included, correct), included.length),
      nonClick: rate(countWhere(nonClick, correct), nonClick.length),
      safeFallback: rate(countWhere(missed, correct), missed.length),
      unsafeClick: rate(
        countWhere(records, (record) => record.outcome.unsafeClick),
        records.length,
      ),
      invalidCount: countWhere(
        records,
        (record) => record.outcome.attribution === "decision-invalid",
      ),
      providerErrorCount: countWhere(
        records,
        (record) => record.outcome.attribution === "provider-error",
      ),
    },
  };
}

async function evaluateFixture(
  fixture: DecisionFixture,
  builder: CandidateBuilder,
  provider: DecisionProvider,
): Promise<FixtureRecord> {
  // 深冻结的克隆：provider / builder 修改输入不会污染后续 fixture 或下一次运行。
  const observation = deepFreeze(structuredClone(fixture.observation));
  const built = builder.build(observation, fixture.microGoal);
  validateCandidateSet(built, observation, builder.name, fixture.name);
  const candidates = deepFreeze(structuredClone(built));

  const targets = fixture.acceptableTargets ?? [];
  const clickFixture = fixture.acceptableOperations.includes("CLICK");
  const rankIndex = clickFixture
    ? candidates.refs.findIndex((ref) => targets.includes(ref))
    : -1;
  const included = rankIndex >= 0;

  const base = {
    name: fixture.name,
    tags: [...fixture.tags],
    candidateCount: candidates.refs.length,
    candidateCoverage: candidates.coverage,
    targetRank: included ? rankIndex + 1 : null,
  };

  let raw: unknown;
  try {
    raw = await provider.decide({
      observation,
      microGoal: fixture.microGoal,
      candidates,
    });
  } catch {
    return {
      outcome: {
        ...base,
        decision: null,
        valid: false,
        correct: false,
        unsafeClick: false,
        attribution: "provider-error",
      },
      clickFixture,
      included,
      candidateRefs: [...candidates.refs],
      targets,
    };
  }

  const { decision, valid, rawClick } = sanitizeDecision(raw, candidates.refs);
  const correct =
    valid &&
    decision !== null &&
    fixture.acceptableOperations.includes(decision.operation) &&
    (decision.operation !== "CLICK" || targets.includes(decision.ref));
  // CLICK 不可接受时 targets 为空，因此“非 correct 的 CLICK”恰好就是点错或非法点击。
  const unsafeClick = rawClick && !correct;

  let attribution: FixtureAttribution;
  if (clickFixture && !included && !correct) {
    attribution = "candidate-miss";
  } else if (!valid) {
    attribution = "decision-invalid";
  } else if (!correct) {
    attribution = "decision-wrong";
  } else {
    attribution = "ok";
  }

  return {
    outcome: {
      ...base,
      decision,
      valid,
      correct,
      unsafeClick,
      attribution,
    },
    clickFixture,
    included,
    candidateRefs: [...candidates.refs],
    targets,
  };
}

/**
 * 离线决策评测：Candidate Recall@K 与 Decision Conditional Accuracy 分开统计。
 *
 * 先校验整组 fixture 与 ks，再按输入顺序串行运行；同输入同 provider 的报告深相等。
 */
export async function runDecisionEvaluation(
  input: RunDecisionEvaluationInput,
): Promise<DecisionEvaluationReport> {
  const ks = validateKs(input.ks ?? DEFAULT_RECALL_KS);
  validateDecisionFixtures(input.fixtures);

  const records: FixtureRecord[] = [];
  for (const fixture of input.fixtures) {
    records.push(await evaluateFixture(fixture, input.builder, input.provider));
  }

  const byTag: Partial<Record<FixtureTag, DecisionMetrics>> = {};
  for (const tag of FIXTURE_TAGS) {
    const tagged = records.filter((record) => record.outcome.tags.includes(tag));
    if (tagged.length > 0) {
      byTag[tag] = summarize(tagged, ks);
    }
  }

  return {
    builder: input.builder.name,
    provider: input.provider.name,
    ks,
    overall: summarize(records, ks),
    byTag,
    fixtures: records.map((record) => record.outcome),
  };
}
