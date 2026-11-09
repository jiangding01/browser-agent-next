import { effectiveFrameOrigin } from "@browser-agent-next/core";
import {
  hasBlockingLayer,
  type Decision,
  type DecisionProvider,
  type DecisionProviderInput,
} from "@browser-agent-next/router";
import {
  isJevProviderError,
  jevProviderError,
  postSystemOne,
} from "./jevClient.js";
import {
  JEV_CHOICE_LIMIT,
  JEV_MODEL,
  QUESTION_IDS,
  buildJevRequest,
  type JevCandidateEntry,
  type JevRequest,
  type OperationOption,
} from "./jevRequest.js";

/** 候选上限：现有 35 个 CLICK fixture 在 30 下零漏召回（docs/JEV-PROVIDER.md「决策规则」）。 */
export const JEV_DEFAULT_MAX_CANDIDATES = 30;
/** operation=click、has_target 与两个 target 答案的共同下限（官方 Noul 起点与 probability routing 低风险档）。 */
export const JEV_MIN_PROBABILITY = 0.7;
export const JEV_PROVIDER_NAME = "jev:" + JEV_MODEL;

export type JevRule =
  | "no-candidates"
  | "blocking-layer"
  | "non-click"
  | "click"
  | "below-threshold"
  | "no-target"
  | "order-disagree"
  | "indistinguishable"
  | "occluded"
  | "out-of-viewport"
  | "origin-unknown";

export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface JevCallRecord {
  rule: JevRule;
  minProbability: number;
  /** 前置闸门命中时不发请求，以下字段都不存在。 */
  model?: string;
  usage?: JevUsage;
  latencyMs?: number;
  answers?: {
    operation: JevChoiceAnswer;
    hasTarget: number;
    targetForward?: JevChoiceAnswer;
    targetReverse?: JevChoiceAnswer;
  };
}

export interface JevDecisionProviderConfig {
  apiKey: string;
  fetch?: typeof fetch;
  onCall?: (record: JevCallRecord) => void;
}

const OPERATION_DECISIONS: Record<
  Exclude<OperationOption, "click">,
  Exclude<Decision["operation"], "CLICK">
> = {
  escalate: "ESCALATE",
  handoff_form: "HANDOFF_FORM",
  handoff_verify: "HANDOFF_VERIFY",
};

/**
 * 官方：probabilities “approximately summing to 1”。容差给逐项舍入留余量；
 * 只要小于 0.4（2 × 阈值 − 1），就不可能有两个选项同时达到 0.7 的阈值。
 */
const PROBABILITY_SUM_TOLERANCE = 0.1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalid(): never {
  throw jevProviderError("invalid-response");
}

function sameKeySet(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

/** 校验 Choice 答案（不变量 166）：选项必须是本次发出的、且概率等于最大值（允许并列）。 */
function parseChoice(value: unknown, options: readonly string[]): JevChoiceAnswer {
  if (!isRecord(value) || value.type !== "choice") invalid();
  const { choice, confidence, probabilities } = value;
  if (typeof choice !== "string" || !options.includes(choice)) invalid();
  if (!isProbability(confidence)) invalid();
  if (!isRecord(probabilities) || !sameKeySet(probabilities, options)) invalid();
  const parsed: Record<string, number> = {};
  for (const option of options) {
    const probability = probabilities[option];
    if (!isProbability(probability)) invalid();
    parsed[option] = probability;
  }
  const values = Object.values(parsed);
  // 阈值的含义依赖分布归一：未归一时并列的高概率能同时越过阈值。
  const sum = values.reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) invalid();
  if (parsed[choice] !== Math.max(...values)) invalid();
  return { choice, confidence, probabilities: parsed };
}

function parseNoul(value: unknown): number {
  if (!isRecord(value) || value.type !== "noul" || !isProbability(value.noul)) invalid();
  return value.noul;
}

interface ParsedResponse {
  model: string;
  usage?: JevUsage;
  operation: JevChoiceAnswer;
  hasTarget: number;
  targetForward?: JevChoiceAnswer;
  targetReverse?: JevChoiceAnswer;
}

/** 只保留 usage 中的数值字段：响应决定类型与大小，不原样进入调用记录。 */
function sanitizeUsage(value: unknown): JevUsage | undefined {
  if (!isRecord(value)) return undefined;
  const count = (item: unknown) =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : undefined;
  const inputTokens = count(value.input_tokens);
  const outputTokens = count(value.output_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function parseResponse(json: unknown, request: JevRequest): ParsedResponse {
  // 请求固定了版本号，作答的必须是同一版本；否则阈值含义不再成立。
  if (!isRecord(json) || json.model !== JEV_MODEL || !isRecord(json.answers)) {
    invalid();
  }
  const { answers } = json;
  const sent = Object.keys(request.sentOptions);
  if (!sameKeySet(answers, sent)) invalid();

  const operation = parseChoice(
    answers[QUESTION_IDS.operation],
    request.sentOptions[QUESTION_IDS.operation]!,
  );
  const hasTarget = parseNoul(answers[QUESTION_IDS.hasTarget]);
  const forwardOptions = request.sentOptions[QUESTION_IDS.targetForward];
  const reverseOptions = request.sentOptions[QUESTION_IDS.targetReverse];

  const usage = sanitizeUsage(json.usage);
  return {
    model: JEV_MODEL,
    ...(usage !== undefined ? { usage } : {}),
    operation,
    hasTarget,
    ...(forwardOptions
      ? { targetForward: parseChoice(answers[QUESTION_IDS.targetForward], forwardOptions) }
      : {}),
    ...(reverseOptions
      ? { targetReverse: parseChoice(answers[QUESTION_IDS.targetReverse], reverseOptions) }
      : {}),
  };
}

/** 后置闸门（确定性，docs/JEV-PROVIDER.md「后置闸门」）：返回拒绝原因，通过时返回 null。 */
function postGate(
  chosen: JevCandidateEntry,
  request: JevRequest,
  observation: DecisionProviderInput["observation"],
): JevRule | null {
  // 与页面上全部可点击元素比较（含被截断到候选集外的），比较键忽略大小写、空白与不可见字符。
  if (
    request.clickableIdentities.some(
      (other) => other.ref !== chosen.ref && other.identityKey === chosen.identityKey,
    )
  ) {
    return "indistinguishable";
  }
  if (chosen.element.geometry?.hitTestable === false) return "occluded";
  if (chosen.element.geometry?.inViewport === false) return "out-of-viewport";
  if (effectiveFrameOrigin(observation, chosen.element.frameId) === undefined) {
    return "origin-unknown";
  }
  return null;
}

/**
 * Jev（typesafe.ai System One）DecisionProvider，见 docs/JEV-PROVIDER.md 与不变量 166～170。
 *
 * 不读取 `input.intent`：结构化 intent 归 deterministic router（组合用 routedDecisionProvider）。
 * 失败一律抛 JevProviderError；运行期调用方应映射为 ESCALATE。
 */
export function createJevDecisionProvider(
  config: JevDecisionProviderConfig,
): DecisionProvider {
  if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
    throw new Error("jev: apiKey must be a non-empty string");
  }
  const { apiKey, onCall } = config;

  const escalate = (rule: JevRule): Decision => {
    onCall?.({ rule, minProbability: JEV_MIN_PROBABILITY });
    return { operation: "ESCALATE" };
  };

  return {
    name: JEV_PROVIDER_NAME,
    async decide(input) {
      const { observation, candidates } = input;
      if (candidates.refs.length === 0) return escalate("no-candidates");
      if (hasBlockingLayer(observation)) return escalate("blocking-layer");
      if (candidates.refs.length > JEV_CHOICE_LIMIT) {
        throw jevProviderError("invalid-request");
      }

      let request: JevRequest;
      try {
        request = await buildJevRequest(input);
      } catch (error) {
        if (isJevProviderError(error)) throw error;
        throw jevProviderError("invalid-request");
      }

      const { json, latencyMs } = await postSystemOne({
        apiKey,
        body: request.body,
        fetch: config.fetch ?? globalThis.fetch,
      });
      const parsed = parseResponse(json, request);

      const finish = (rule: JevRule, decision: Decision): Decision => {
        onCall?.({
          rule,
          minProbability: JEV_MIN_PROBABILITY,
          model: parsed.model,
          ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
          latencyMs,
          answers: {
            operation: parsed.operation,
            hasTarget: parsed.hasTarget,
            ...(parsed.targetForward ? { targetForward: parsed.targetForward } : {}),
            ...(parsed.targetReverse ? { targetReverse: parsed.targetReverse } : {}),
          },
        });
        return decision;
      };
      const escalateAfterCall = (rule: JevRule) =>
        finish(rule, { operation: "ESCALATE" });

      const operation = parsed.operation.choice as OperationOption;
      if (operation !== "click") {
        return finish("non-click", {
          operation: OPERATION_DECISIONS[operation],
          confidence: parsed.operation.confidence,
        });
      }

      if (parsed.operation.probabilities.click! < JEV_MIN_PROBABILITY) {
        return escalateAfterCall("below-threshold");
      }
      if (parsed.hasTarget < JEV_MIN_PROBABILITY) return escalateAfterCall("no-target");

      let chosen: JevCandidateEntry;
      let confidence = parsed.operation.confidence;
      if (request.entries.length === 1) {
        chosen = request.entries[0]!;
      } else {
        const forward = parsed.targetForward!;
        const reverse = parsed.targetReverse!;
        if (forward.choice !== reverse.choice) return escalateAfterCall("order-disagree");
        if (
          forward.probabilities[forward.choice]! < JEV_MIN_PROBABILITY ||
          reverse.probabilities[reverse.choice]! < JEV_MIN_PROBABILITY
        ) {
          return escalateAfterCall("below-threshold");
        }
        chosen = request.entries.find((entry) => entry.label === forward.choice)!;
        confidence = Math.min(confidence, forward.confidence, reverse.confidence);
      }

      const rejected = postGate(chosen, request, observation);
      if (rejected !== null) return escalateAfterCall(rejected);

      return finish("click", { operation: "CLICK", ref: chosen.ref, confidence });
    },
  };
}
