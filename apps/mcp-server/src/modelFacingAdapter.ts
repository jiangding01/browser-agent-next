import {
  BrowserRuntimeError,
  type BrowserExtractResult,
  type BrowserObservation,
  type BrowserObserveInput,
  type BrowserObserveOptions,
  type BrowserOpenInput,
  type BrowserOpenResult,
  type BrowserVerifyInput,
  type BrowserWaitInput,
  type BrowserWaitResult,
  type VerificationResult,
} from "@browser-agent-next/core";
import {
  type ModelFacingToolName,
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
} from "@browser-agent-next/policy";
import { verifyObservation } from "@browser-agent-next/runtime";
import type {
  ModelActBroker,
  ModelActExecution,
  ModelToolCallContext,
} from "./modelActBroker.js";
import {
  ModelEgressProjector,
  ModelVisibleObservationStore,
  sanitizedVerification,
  type ModelEgressOptions,
} from "./modelEgress.js";
import {
  MODEL_INPUT_LIMITS,
  parseModelActInput,
  parseModelExtractInput,
  parseModelObserveInput,
  parseModelOpenInput,
  parseModelVerifyInput,
  parseModelWaitInput,
  type ModelActInput,
  type ModelExtractInput,
} from "./modelToolInput.js";

export interface ModelBrowserRuntimeClient {
  open(input: BrowserOpenInput): Promise<BrowserOpenResult>;
  observe(input: BrowserObserveInput): Promise<BrowserObservation>;
}

export interface ModelFacingAdapterOptions {
  tools: ModelToolExposurePolicy;
  origins: ModelOriginAccessPolicy;
  egress?: ModelEgressOptions;
  /**
   * 仅当 operator 显式暴露 browser.act 时由组装层注入；
   * 未注入时 browser.act 一律 POLICY_BLOCKED。
   */
  actBroker?: ModelActBroker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 模型可见的 browser.act 结果。
 *
 * verification / verificationAttempts 由 adapter 在动作后、已投影且已进入本连接
 * 出境 store 的 observation 上本地计算；扩展侧 verification 从不出境。
 */
export interface ModelActResult extends ModelActExecution {
  verification: VerificationResult;
  verificationAttempts: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 3_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 100;
/**
 * browser.act 未指定 verifyTimeoutMs 时的本地验证窗口。
 *
 * 取扩展侧 browser.act 原有默认值 1.5s：小于 wait 默认 3s，
 * 让副作用调用的尾延迟保持有界，需要更长等待时由模型显式传入或另行 wait。
 */
export const MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS = 1_500;

type ModelToolResult =
  | BrowserOpenResult
  | BrowserObservation
  | BrowserExtractResult
  | VerificationResult
  | BrowserWaitResult
  | ModelActResult;

/**
 * 面向模型的 adapter。
 *
 * 它故意只依赖 trusted runtime 的 browser.open/browser.observe 两个最小原语：
 * extract/verify/wait 都在已经通过 model-egress policy 的 observation 上本地执行，
 * 避免模型通过隐藏 frame、未出境 revision 或 verification boolean 形成旁路读取。
 * authorization issuance、auto-act policy mutation、raw trusted RPC 从类型和工具目录上都不可达；
 * browser.act 只能把已出境 revision 中已投影的 ref 交给 MCP 进程内的 act broker，
 * 授权 id 与授权路径由 broker 决定，模型不可提供。
 */
export class ModelFacingBrowserAdapter {
  private readonly includeValues: boolean;
  private readonly maxObservationElements: number;
  private readonly states: ModelVisibleObservationStore;
  private readonly projector: ModelEgressProjector;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly runtime: ModelBrowserRuntimeClient,
    private readonly options: ModelFacingAdapterOptions,
  ) {
    this.includeValues =
      options.egress?.includeValues ?? false;
    this.maxObservationElements = boundedConfig(
      options.egress?.maxObservationElements ?? 100,
      "maxObservationElements",
      1,
      MODEL_INPUT_LIMITS.maxObserveElements,
    );
    const maxVisibleRevisions = boundedConfig(
      options.egress?.maxVisibleRevisions ?? 64,
      "maxVisibleRevisions",
      1,
      512,
    );

    this.states = new ModelVisibleObservationStore(
      maxVisibleRevisions,
    );
    this.projector = new ModelEgressProjector(
      options.origins,
      this.maxObservationElements,
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    );
  }

  async invoke(
    tool: string,
    input: unknown,
    context?: ModelToolCallContext,
  ): Promise<ModelToolResult> {
    if (!this.options.tools.isExposed(tool)) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "model-facing tool is not exposed: " + tool,
      );
    }

    switch (tool) {
      case "browser.open":
        return this.open(parseModelOpenInput(input));
      case "browser.observe":
        return this.observe(parseModelObserveInput(input));
      case "browser.extract":
        return this.extract(parseModelExtractInput(input));
      case "browser.verify":
        return this.verify(parseModelVerifyInput(input));
      case "browser.wait":
        return this.wait(parseModelWaitInput(input));
      case "browser.act":
        return this.act(input, context);
    }
  }

  exposedTools(): ModelFacingToolName[] {
    return this.options.tools.values();
  }

  private async open(
    input: BrowserOpenInput,
  ): Promise<BrowserOpenResult> {
    if (!this.options.origins.canNavigate(input.url)) {
      throw new BrowserRuntimeError(
        "ORIGIN_NOT_ALLOWED",
        "model navigation origin is not allowlisted",
      );
    }

    return this.runtime.open(input);
  }

  private async observe(
    input: BrowserObserveInput,
  ): Promise<BrowserObservation> {
    if (
      input.sinceRevision !== undefined &&
      this.states.get(
        input.tabId,
        input.sinceRevision,
      ) === undefined
    ) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "sinceRevision was not previously exposed to this model adapter",
      );
    }

    const modelOptions = this.modelObserveOptions(
      input.options,
    );
    const observation = await this.runtime.observe({
      tabId: input.tabId,
      ...(input.sinceRevision !== undefined
        ? { sinceRevision: input.sinceRevision }
        : {}),
      options: modelOptions,
    });
    const projected = this.projector.project(
      observation,
      modelOptions.includeValues === true,
    );

    this.states.put(projected);
    return projected;
  }

  private extract(
    input: ModelExtractInput,
  ): BrowserExtractResult {
    const observation = this.requireVisibleObservation(
      input.tabId,
      input.observedRevision,
      "browser.extract",
    );
    const requested = input.refs
      ? new Set(input.refs)
      : undefined;
    const matched = requested
      ? observation.elements.filter(
          (element) => requested.has(element.ref),
        )
      : observation.elements;
    const found = new Set(
      matched.map((element) => element.ref),
    );
    const maxItems =
      input.maxItems ?? MODEL_INPUT_LIMITS.maxRefs;

    return {
      revision: observation.revision.id,
      items: matched.slice(0, maxItems),
      missingRefs:
        input.refs?.filter((ref) => !found.has(ref)) ?? [],
      truncated: matched.length > maxItems,
      totalMatched: matched.length,
      actionableCoverage:
        observation.coverage.actionable.status,
    };
  }

  private verify(
    input: BrowserVerifyInput,
  ): VerificationResult {
    const observation = this.requireVisibleObservation(
      input.tabId,
      input.observedRevision,
      "browser.verify",
    );

    return sanitizedVerification(
      verifyObservation(
        observation,
        input.verification,
      ),
    );
  }

  private wait(
    input: BrowserWaitInput,
  ): Promise<BrowserWaitResult> {
    return this.pollVerification(input, true);
  }

  /**
   * wait 与 act 后验证共用的本地轮询。
   *
   * 每次都经 observe() 取得已投影并写入出境 store 的 observation，再本地验证。
   * rethrowPolicyErrors 为 false 时（act 后验证），egress/policy 失败也只记为
   * observation 不可用，因为动作已经执行，不能把整个 act 报错。
   */
  private async pollVerification(
    input: BrowserWaitInput,
    rethrowPolicyErrors: boolean,
  ): Promise<BrowserWaitResult> {
    const timeoutMs =
      input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs =
      input.pollIntervalMs ??
      DEFAULT_WAIT_POLL_INTERVAL_MS;
    const deadline = this.now() + timeoutMs;
    let attempts = 0;
    let lastObservation: BrowserObservation | undefined;
    let lastVerification: VerificationResult | undefined;
    let lastObservationError: string | undefined;

    do {
      attempts += 1;

      try {
        const observation = await this.observe({
          tabId: input.tabId,
          ...(input.options !== undefined
            ? { options: input.options }
            : {}),
        });
        lastObservation = observation;
        lastObservationError = undefined;
        lastVerification = sanitizedVerification(
          verifyObservation(
            observation,
            input.verification,
          ),
        );

        if (lastVerification.verified) {
          return {
            verification: lastVerification,
            attempts,
            timedOut: false,
            observation,
          };
        }
      } catch (error) {
        if (
          rethrowPolicyErrors &&
          error instanceof BrowserRuntimeError &&
          (
            error.code === "MODEL_EGRESS_BLOCKED" ||
            error.code === "POLICY_BLOCKED" ||
            error.code === "ORIGIN_NOT_ALLOWED"
          )
        ) {
          throw error;
        }
        lastObservationError = boundedError(error);
      }

      if (this.now() >= deadline) break;
      await this.sleep(
        Math.min(
          pollIntervalMs,
          Math.max(0, deadline - this.now()),
        ),
      );
    } while (this.now() <= deadline);

    return {
      verification: lastVerification ?? {
        verified: false,
        conclusive: false,
        evidence: input.verification.conditions.map(
          (condition) => ({
            condition,
            pass: false,
            conclusive: false,
            reason: lastObservationError
              ? "model-facing observation unavailable: " +
                lastObservationError
              : "model-facing wait timed out before any verifiable observation",
          }),
        ),
      },
      attempts,
      timedOut: true,
      ...(lastObservation !== undefined
        ? { observation: lastObservation }
        : {}),
      ...(lastObservationError !== undefined
        ? { lastObservationError }
        : {}),
    };
  }

  private async act(
    rawInput: unknown,
    context: ModelToolCallContext | undefined,
  ): Promise<ModelActResult> {
    const broker = this.options.actBroker;
    if (!broker) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "model act broker is not configured",
      );
    }

    const input: ModelActInput =
      parseModelActInput(rawInput);
    const observation = this.requireVisibleObservation(
      input.tabId,
      input.observedRevision,
      "browser.act",
    );
    if (
      !observation.elements.some(
        (element) => element.ref === input.ref,
      )
    ) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "browser.act ref was not exposed in the observed revision",
      );
    }

    const execution = await broker.act(
      input,
      observation,
      context,
    );

    // 动作已执行：此后任何 observe 失败都只让 verification inconclusive。
    const polled = await this.pollVerification(
      {
        tabId: input.tabId,
        verification: input.verification,
        timeoutMs:
          input.verifyTimeoutMs ??
          MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS,
      },
      false,
    );

    return {
      status: execution.status,
      effectClass: execution.effectClass,
      // 有投影 observation 时 verification 来自本地验证（revision 已入出境 store）；
      // 否则给出固定的 inconclusive，不透传 lastObservationError 原文。
      verification:
        polled.observation !== undefined
          ? polled.verification
          : unavailableActVerification(input),
      verificationAttempts: polled.attempts,
    };
  }

  private modelObserveOptions(
    requested: BrowserObserveOptions | undefined,
  ): BrowserObserveOptions {
    const requestedMax =
      requested?.maxElements ??
      this.maxObservationElements;
    if (requestedMax > this.maxObservationElements) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "model observation maxElements exceeds egress policy",
      );
    }

    const requestedAxMax =
      requested?.maxAxElements ??
      this.maxObservationElements;
    if (requestedAxMax > this.maxObservationElements) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "model observation maxAxElements exceeds egress policy",
      );
    }

    return {
      ...(requested?.profile !== undefined
        ? { profile: requested.profile }
        : {}),
      maxElements: requestedMax,
      maxAxElements: requestedAxMax,
      includeValues:
        this.includeValues &&
        requested?.includeValues === true,
      ...(requested?.includeOpenShadowRoots !== undefined
        ? {
            includeOpenShadowRoots:
              requested.includeOpenShadowRoots,
          }
        : {}),
    };
  }

  private requireVisibleObservation(
    tabId: number,
    revision: string,
    tool: string,
  ): BrowserObservation {
    const observation = this.states.get(
      tabId,
      revision,
    );
    if (!observation) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        tool +
          " requires a revision previously exposed by this model adapter",
      );
    }

    return observation;
  }
}

function boundedConfig(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      name +
        " must be an integer between " +
        min +
        " and " +
        max,
    );
  }

  return value;
}

function unavailableActVerification(
  input: ModelActInput,
): VerificationResult {
  return {
    verified: false,
    conclusive: false,
    evidence: input.verification.conditions.map(
      (condition) => ({
        condition,
        pass: false,
        conclusive: false,
        reason:
          "model-facing observation unavailable after browser.act",
      }),
    ),
  };
}

function boundedError(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : "model-facing observation failed"
  ).slice(0, 500);
}
