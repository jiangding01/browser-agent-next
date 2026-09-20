import {
  BrowserRuntimeError,
  type BrowserActionKind,
  type BrowserObservation,
  type VerificationResult,
  type VerificationSpec,
} from "@browser-agent-next/core";
import {
  verifyObservation,
  type TabStateStore,
} from "@browser-agent-next/runtime";
import type { ChromeDomObservationService } from "../chrome/chromeObservationService.js";
import type { TrustedHostExecutionService } from "../execution/trustedHostExecutionService.js";

export interface BrowserObserveOptions {
  profile?: "dom" | "hybrid";
  maxElements?: number;
  maxAxElements?: number;
  includeValues?: boolean;
  includeOpenShadowRoots?: boolean;
}

export interface BrowserObserveInput {
  tabId: number;
  sinceRevision?: string;
  options?: BrowserObserveOptions;
}

export interface BrowserVerifyInput {
  tabId: number;
  observedRevision: string;
  verification: VerificationSpec;
}

export interface BrowserWaitInput {
  tabId: number;
  verification: VerificationSpec;
  timeoutMs?: number;
  pollIntervalMs?: number;
  options?: BrowserObserveOptions;
}

export interface BrowserWaitResult {
  verification: VerificationResult;
  attempts: number;
  timedOut: boolean;
  observation?: BrowserObservation;
  lastObservationError?: string;
}

export interface BrowserActInput {
  tabId: number;
  action: {
    actionId: string;
    kind: BrowserActionKind;
    observedRevision: string;
    ref?: string;
    authorizationId?: string;
  };
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}

export interface BrowserApiServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaultWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  defaultPollIntervalMs?: number;
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
 * 重要：高层 API 不接收 ownedBySession。当前在没有独立 Tab ownership registry
 * 之前一律按 user-existing tab 处理，避免调用方自行降低授权门槛。
 */
export class HighLevelBrowserApiService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultWaitTimeoutMs: number;
  private readonly maxWaitTimeoutMs: number;
  private readonly defaultPollIntervalMs: number;

  constructor(
    private readonly states: TabStateStore,
    private readonly observations: ChromeDomObservationService,
    private readonly trustedExecution: TrustedHostExecutionService,
    options: BrowserApiServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    );
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? 3_000;
    this.maxWaitTimeoutMs = options.maxWaitTimeoutMs ?? 30_000;
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 100;
  }

  observe(input: BrowserObserveInput): Promise<BrowserObservation> {
    const profile = input.options?.profile ?? "hybrid";

    return this.observations.observe({
      tabId: input.tabId,
      ownedBySession: false,
      ...(input.sinceRevision !== undefined
        ? { sinceRevision: input.sinceRevision }
        : {}),
      options: {
        includeAx: profile === "hybrid",
        ...(input.options?.maxElements !== undefined
          ? { maxElements: input.options.maxElements }
          : {}),
        ...(input.options?.maxAxElements !== undefined
          ? { maxAxElements: input.options.maxAxElements }
          : {}),
        ...(input.options?.includeValues !== undefined
          ? { includeValues: input.options.includeValues }
          : {}),
        ...(input.options?.includeOpenShadowRoots !== undefined
          ? {
              includeOpenShadowRoots:
                input.options.includeOpenShadowRoots,
            }
          : {}),
      },
    });
  }

  verify(input: BrowserVerifyInput): VerificationResult {
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
    const requestedTimeout =
      input.timeoutMs ?? this.defaultWaitTimeoutMs;
    const timeoutMs = Math.max(
      0,
      Math.min(requestedTimeout, this.maxWaitTimeoutMs),
    );
    const pollIntervalMs = Math.max(
      50,
      Math.min(
        input.pollIntervalMs ?? this.defaultPollIntervalMs,
        1_000,
      ),
    );
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
          };
        }
      } catch (error) {
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
    };
  }

  async act(input: BrowserActInput) {
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
      ...(input.verifyTimeoutMs !== undefined
        ? { verifyTimeoutMs: input.verifyTimeoutMs }
        : {}),
    });
  }
}
