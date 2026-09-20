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
import {
  ModelEgressProjector,
  ModelVisibleObservationStore,
  sanitizedVerification,
  type ModelEgressOptions,
} from "./modelEgress.js";
import {
  MODEL_INPUT_LIMITS,
  parseModelExtractInput,
  parseModelObserveInput,
  parseModelOpenInput,
  parseModelVerifyInput,
  parseModelWaitInput,
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type ModelToolResult =
  | BrowserOpenResult
  | BrowserObservation
  | BrowserExtractResult
  | VerificationResult
  | BrowserWaitResult;

/**
 * 面向模型的 adapter。
 *
 * 它故意只依赖 trusted runtime 的 browser.open/browser.observe 两个最小原语：
 * extract/verify/wait 都在已经通过 model-egress policy 的 observation 上本地执行，
 * 避免模型通过隐藏 frame、未出境 revision 或 verification boolean 形成旁路读取。
 * authorization issuance、auto-act policy mutation、raw trusted RPC 从类型和工具目录上都不可达。
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

  private async wait(
    input: BrowserWaitInput,
  ): Promise<BrowserWaitResult> {
    const timeoutMs = input.timeoutMs ?? 3_000;
    const pollIntervalMs = input.pollIntervalMs ?? 100;
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

function boundedError(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : "model-facing observation failed"
  ).slice(0, 500);
}
