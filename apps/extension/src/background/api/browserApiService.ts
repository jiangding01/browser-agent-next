import {
  BrowserRuntimeError,
  type BrowserActInput,
  type BrowserExtractInput,
  type BrowserExtractResult,
  type BrowserObservation,
  type BrowserOpenInput,
  type BrowserOpenResult,
  type BrowserObserveInput,
  type BrowserObserveOptions,
  type BrowserVerifyInput,
  type BrowserWaitInput,
  type BrowserWaitResult,
  type VerificationResult,
  type VerificationSpec,
} from "@browser-agent-next/core";
import {
  verifyObservation,
  type TabOwnershipRegistry,
  type TabStateStore,
} from "@browser-agent-next/runtime";
import type { ChromeDomObservationService } from "../chrome/chromeObservationService.js";
import type { TrustedHostExecutionService } from "../execution/trustedHostExecutionService.js";

export interface BrowserTabCreateApi {
  create(input: {
    url: string;
    active?: boolean;
  }): Promise<{
    id?: number;
    url?: string;
  }>;
}

export interface BrowserChangeSignalSource {
  version(tabId: number): number;
  waitForChange(
    tabId: number,
    afterVersion: number,
    timeoutMs: number,
  ): Promise<boolean>;
}

export interface BrowserApiServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaultWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  defaultPollIntervalMs?: number;
  changeSignals?: BrowserChangeSignalSource;
}

function boundedPositiveInteger(
  value: number | undefined,
  name: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BrowserRuntimeError(
      "POLICY_BLOCKED",
      name + " must be an integer between 1 and " + max,
    );
  }
  return value;
}

function normalizedObserveOptions(
  options: BrowserObserveOptions | undefined,
): BrowserObserveOptions {
  if (
    options?.profile !== undefined &&
    options.profile !== "dom" &&
    options.profile !== "hybrid"
  ) {
    throw new BrowserRuntimeError(
      "POLICY_BLOCKED",
      "unsupported browser.observe profile",
    );
  }

  return {
    ...(options?.profile !== undefined
      ? { profile: options.profile }
      : {}),
    ...(boundedPositiveInteger(
      options?.maxElements,
      "maxElements",
      500,
    ) !== undefined
      ? { maxElements: options!.maxElements }
      : {}),
    ...(boundedPositiveInteger(
      options?.maxAxElements,
      "maxAxElements",
      500,
    ) !== undefined
      ? { maxAxElements: options!.maxAxElements }
      : {}),
    ...(options?.includeValues !== undefined
      ? { includeValues: options.includeValues }
      : {}),
    ...(options?.includeOpenShadowRoots !== undefined
      ? {
          includeOpenShadowRoots:
            options.includeOpenShadowRoots,
        }
      : {}),
  };
}

function assertVerificationSpec(
  spec: VerificationSpec,
): void {
  if (
    !Array.isArray(spec.conditions) ||
    spec.conditions.length < 1 ||
    spec.conditions.length > 20
  ) {
    throw new BrowserRuntimeError(
      "POLICY_BLOCKED",
      "verification must contain between 1 and 20 conditions",
    );
  }
}

function boundedFiniteNumber(
  value: number | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new BrowserRuntimeError(
      "POLICY_BLOCKED",
      name + " must be between " + min + " and " + max,
    );
  }
  return value;
}

function boundedError(error: unknown): string {
  return (
    error instanceof Error ? error.message : "browser observation failed"
  ).slice(0, 500);
}

function timeoutVerification(
  spec: VerificationSpec,
  reason: string,
): VerificationResult {
  return {
    verified: false,
    conclusive: false,
    evidence: spec.conditions.map((condition) => ({
      condition,
      pass: false,
      conclusive: false,
      reason,
    })),
  };
}

/**
 * Agent-facing high-level Browser API facade.
 *
 * 重要：高层 API 不接收 caller supplied ownedBySession。
 *
 * ownership 只能由 browser.open 的真实 tabs.create 结果进入 TabOwnershipRegistry；
 * 未记录的 tab 一律按 user-existing 处理。MV3 restart 后 registry 丢失时同样 fail safe。
 */
export class HighLevelBrowserApiService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultWaitTimeoutMs: number;
  private readonly maxWaitTimeoutMs: number;
  private readonly defaultPollIntervalMs: number;
  private readonly changeSignals: BrowserChangeSignalSource | undefined;

  constructor(
    private readonly states: TabStateStore,
    private readonly observations: ChromeDomObservationService,
    private readonly trustedExecution: TrustedHostExecutionService,
    private readonly ownership?: TabOwnershipRegistry,
    private readonly tabs?: BrowserTabCreateApi,
    options: BrowserApiServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    );
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? 3_000;
    this.maxWaitTimeoutMs = options.maxWaitTimeoutMs ?? 30_000;
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 100;
    this.changeSignals = options.changeSignals;
  }

  async open(
    input: BrowserOpenInput,
  ): Promise<BrowserOpenResult> {
    if (!this.ownership || !this.tabs) {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "browser.open is unavailable because tab ownership control is not configured",
      );
    }

    if (
      typeof input.url !== "string" ||
      input.url.length < 1 ||
      input.url.length > 2_048
    ) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "browser.open url must be between 1 and 2048 characters",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "browser.open requires an absolute URL",
      );
    }

    if (
      (parsed.protocol !== "http:" &&
        parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "browser.open only supports credential-free http/https URLs",
      );
    }

    const created = await this.tabs.create({
      url: parsed.href,
      ...(input.active !== undefined
        ? { active: input.active }
        : {}),
    });

    if (
      typeof created.id !== "number" ||
      !Number.isInteger(created.id) ||
      created.id < 0
    ) {
      throw new BrowserRuntimeError(
        "ACTION_OUTCOME_UNKNOWN",
        "Chrome created a tab without a usable tabId",
      );
    }

    this.ownership.markCreated(created.id);

    return {
      tabId: created.id,
      requestedUrl: parsed.href,
      ownedBySession: true,
    };
  }

  async observe(
    input: BrowserObserveInput,
  ): Promise<BrowserObservation> {
    const options = normalizedObserveOptions(input.options);
    const profile = options.profile ?? "hybrid";

    return this.observations.observe({
      tabId: input.tabId,
      ownedBySession:
        this.ownership?.isOwned(input.tabId) ?? false,
      ...(input.sinceRevision !== undefined
        ? { sinceRevision: input.sinceRevision }
        : {}),
      options: {
        includeAx: profile === "hybrid",
        ...(options.maxElements !== undefined
          ? { maxElements: options.maxElements }
          : {}),
        ...(options.maxAxElements !== undefined
          ? { maxAxElements: options.maxAxElements }
          : {}),
        ...(options.includeValues !== undefined
          ? { includeValues: options.includeValues }
          : {}),
        ...(options.includeOpenShadowRoots !== undefined
          ? {
              includeOpenShadowRoots:
                options.includeOpenShadowRoots,
            }
          : {}),
      },
    });
  }

  extract(
    input: BrowserExtractInput,
  ): BrowserExtractResult {
    const maxItems =
      boundedPositiveInteger(
        input.maxItems,
        "maxItems",
        100,
      ) ?? 100;

    if (
      input.refs !== undefined &&
      (
        !Array.isArray(input.refs) ||
        input.refs.length < 1 ||
        input.refs.length > 100 ||
        input.refs.some(
          (ref) =>
            typeof ref !== "string" ||
            ref.length < 1 ||
            ref.length > 256,
        )
      )
    ) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "browser.extract refs must contain between 1 and 100 bounded refs",
      );
    }

    const stored = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "browser.extract requires a retained observation",
      );
    }

    const requested = input.refs
      ? new Set(input.refs)
      : undefined;

    const matched = requested
      ? stored.observation.elements.filter(
          (element) => requested.has(element.ref),
        )
      : stored.observation.elements;

    const foundRefs = new Set(
      matched.map((element) => element.ref),
    );

    const missingRefs = input.refs
      ? input.refs.filter((ref) => !foundRefs.has(ref))
      : [];

    return {
      revision: stored.observation.revision.id,
      items: matched.slice(0, maxItems),
      missingRefs,
      truncated: matched.length > maxItems,
      totalMatched: matched.length,
      actionableCoverage:
        stored.observation.coverage.actionable.status,
    };
  }

  verify(input: BrowserVerifyInput): VerificationResult {
    assertVerificationSpec(input.verification);

    const stored = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "browser.verify requires a retained observation",
      );
    }

    return verifyObservation(
      stored.observation,
      input.verification,
    );
  }

  async wait(input: BrowserWaitInput): Promise<BrowserWaitResult> {
    assertVerificationSpec(input.verification);
    const observeOptions = normalizedObserveOptions(input.options);

    const requestedTimeout =
      boundedFiniteNumber(
        input.timeoutMs,
        "timeoutMs",
        0,
        this.maxWaitTimeoutMs,
      ) ?? this.defaultWaitTimeoutMs;
    const timeoutMs = requestedTimeout;

    const pollIntervalMs =
      boundedFiniteNumber(
        input.pollIntervalMs,
        "pollIntervalMs",
        50,
        1_000,
      ) ?? this.defaultPollIntervalMs;
    const deadline = this.now() + timeoutMs;
    let attempts = 0;
    let signalWakeups = 0;
    let lastObservation: BrowserObservation | undefined;
    let lastVerification: VerificationResult | undefined;
    let lastObservationError: string | undefined;

    do {
      attempts += 1;

      // 在 Observe 之前记录 cursor，避免观察窗口内发生 mutation 后丢唤醒。
      const signalVersion =
        this.changeSignals?.version(input.tabId);

      try {
        const observation = await this.observe({
          tabId: input.tabId,
          options: observeOptions,
        });
        lastObservation = observation;
        lastObservationError = undefined;
        lastVerification = verifyObservation(
          observation,
          input.verification,
        );

        if (lastVerification.verified) {
          return {
            verification: lastVerification,
            attempts,
            timedOut: false,
            observation,
            ...(this.changeSignals !== undefined
              ? { signalWakeups }
              : {}),
          };
        }
      } catch (error) {
        lastObservationError = boundedError(error);
      }

      if (this.now() >= deadline) break;

      const boundedWaitMs = Math.min(
        pollIntervalMs,
        Math.max(0, deadline - this.now()),
      );

      if (
        this.changeSignals !== undefined &&
        signalVersion !== undefined
      ) {
        const changed =
          await this.changeSignals.waitForChange(
            input.tabId,
            signalVersion,
            boundedWaitMs,
          );
        if (changed) signalWakeups += 1;
      } else {
        await this.sleep(boundedWaitMs);
      }
    } while (this.now() <= deadline);

    return {
      verification:
        lastVerification ??
        timeoutVerification(
          input.verification,
          lastObservationError
            ? "browser.wait observation unavailable: " + lastObservationError
            : "browser.wait timed out before any verifiable observation",
        ),
      attempts,
      timedOut: true,
      ...(lastObservation !== undefined
        ? { observation: lastObservation }
        : {}),
      ...(lastObservationError !== undefined
        ? { lastObservationError }
        : {}),
      ...(this.changeSignals !== undefined
        ? { signalWakeups }
        : {}),
    };
  }

  async act(input: BrowserActInput) {
    assertVerificationSpec(input.verification);
    const verifyTimeoutMs = boundedFiniteNumber(
      input.verifyTimeoutMs,
      "verifyTimeoutMs",
      0,
      5_000,
    );

    if (input.action.kind !== "click") {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "browser.act currently supports strict click only",
      );
    }

    if (!input.action.ref || !input.action.authorizationId) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "browser.act strict click requires ref and authorizationId",
      );
    }

    return this.trustedExecution.executeStrictClickAndVerify({
      actionId: input.action.actionId,
      authorizationId: input.action.authorizationId,
      tabId: input.tabId,
      observedRevision: input.action.observedRevision,
      ref: input.action.ref,
      verification: input.verification,
      ...(verifyTimeoutMs !== undefined
        ? { verifyTimeoutMs }
        : {}),
    });
  }
}
