import {
  BrowserRuntimeError,
  type AuthorizationAssurance,
  type VerificationResult,
  type VerificationSpec,
} from "@browser-agent-next/core";
import {
  authorizationAssuranceSatisfies,
  minimumAuthorizationAssurance,
  type InMemoryAuthorizationStore,
  type MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import {
  verifyObservation,
  type TabStateStore,
} from "@browser-agent-next/runtime";
import type {
  ChromeDomObservationService,
} from "../chrome/chromeObservationService.js";
import type {
  ExecuteStrictClickResult,
  PolicyGatedStrictClickExecutor,
} from "./policyGatedStrictClick.js";

export interface TrustedAuthorizationInput {
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  ttlMs: number;
}

export interface TrustedExecuteAndVerifyInput {
  actionId: string;
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}

const TRUSTED_HOST_ASSURANCE: AuthorizationAssurance =
  "control-plane";

export interface TrustedExecuteAndVerifyResult {
  execution: ExecuteStrictClickResult;
  verification: VerificationResult;
  verificationAttempts: number;
  freshRevision?: string;
  postActionObservationError?: string;
}

export interface TrustedHostExecutionServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxVerifyTimeoutMs?: number;
  maxAuthorizationTtlMs?: number;
}

function boundedError(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : "post-action observation failed"
  ).slice(0, 500);
}

function inconclusiveVerification(
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
 * 只供 trusted native-host ingress 调用。
 *
 * 普通 extension runtime message 不会拿到这个 service 的 issue/execute 能力。
 */
export class TrustedHostExecutionService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxVerifyTimeoutMs: number;
  private readonly maxAuthorizationTtlMs: number;

  constructor(
    private readonly states: TabStateStore,
    private readonly authorizations: InMemoryAuthorizationStore,
    private readonly origins: MutableExactOriginAllowlist,
    private readonly executor: PolicyGatedStrictClickExecutor,
    private readonly observations: ChromeDomObservationService,
    options: TrustedHostExecutionServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    );
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxVerifyTimeoutMs = options.maxVerifyTimeoutMs ?? 5_000;
    this.maxAuthorizationTtlMs =
      options.maxAuthorizationTtlMs ?? 60_000;
  }

  replaceAutoActOrigins(origins: readonly string[]): string[] {
    return this.origins.replace(origins);
  }

  issueStrictClickAuthorization(
    input: TrustedAuthorizationInput,
  ): {
    id: string;
    expiresAt: number;
    origin: string;
    assurance: AuthorizationAssurance;
  } {
    if (
      !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.ttlMs > this.maxAuthorizationTtlMs
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "trusted authorization ttl is outside the allowed range",
      );
    }

    const stored = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "cannot authorize an observation that is no longer retained",
      );
    }

    if (!stored.byRef.has(input.ref)) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "cannot authorize a ref outside the retained observation",
      );
    }

    if (!this.origins.isAllowed(stored.observation.tab.origin)) {
      throw new BrowserRuntimeError(
        "ORIGIN_NOT_ALLOWED",
        "cannot authorize strict click on an origin outside the auto-act allowlist",
      );
    }

    const requiredAssurance =
      minimumAuthorizationAssurance(
        "unknown",
        stored.observation.tab.ownedBySession,
      );

    if (
      requiredAssurance !== undefined &&
      !authorizationAssuranceSatisfies(
        TRUSTED_HOST_ASSURANCE,
        requiredAssurance,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "trusted control-plane grant is insufficient for this tab; required assurance: " +
          requiredAssurance,
        {
          requiredAssurance,
          availableAssurance: TRUSTED_HOST_ASSURANCE,
        },
      );
    }

    const grant = this.authorizations.issue({
      id: input.authorizationId,
      tabId: input.tabId,
      observedRevision: input.observedRevision,
      ref: input.ref,
      actionKind: "click",
      effectClass: "unknown",
      assurance: TRUSTED_HOST_ASSURANCE,
      ttlMs: input.ttlMs,
      singleUse: true,
      source: "trusted-host",
    });

    return {
      id: grant.id,
      expiresAt: grant.expiresAt,
      origin: stored.observation.tab.origin,
      assurance: grant.assurance,
    };
  }

  async executeStrictClickAndVerify(
    input: TrustedExecuteAndVerifyInput,
  ): Promise<TrustedExecuteAndVerifyResult> {
    const baseline = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!baseline) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "execute requires a retained observation",
      );
    }

    const execution = await this.executor.execute({
      tabId: input.tabId,
      actionId: input.actionId,
      observedRevision: input.observedRevision,
      ref: input.ref,
      authorizationId: input.authorizationId,
    });

    const requestedTimeout = input.verifyTimeoutMs ?? 1_500;
    const timeoutMs = Math.max(
      0,
      Math.min(requestedTimeout, this.maxVerifyTimeoutMs),
    );
    const deadline = this.now() + timeoutMs;

    let attempts = 0;
    let lastObservationError: string | undefined;

    do {
      attempts += 1;

      try {
        const fresh = await this.observations.observe({
          tabId: input.tabId,
          ownedBySession:
            baseline.observation.tab.ownedBySession,
          options: {
            includeAx: true,
          },
        });

        const verification = verifyObservation(
          fresh,
          input.verification,
        );

        if (verification.conclusive || this.now() >= deadline) {
          return {
            execution,
            verification,
            verificationAttempts: attempts,
            freshRevision: fresh.revision.id,
          };
        }
      } catch (error) {
        // 这里只重试 observation/verification，绝不重放 click。
        lastObservationError = boundedError(error);
      }

      if (this.now() >= deadline) break;
      await this.sleep(
        Math.min(
          this.pollIntervalMs,
          Math.max(0, deadline - this.now()),
        ),
      );
    } while (this.now() <= deadline);

    return {
      execution,
      verification: inconclusiveVerification(
        input.verification,
        lastObservationError
          ? "post-action observation remained unavailable: " +
            lastObservationError
          : "verification remained inconclusive before timeout",
      ),
      verificationAttempts: attempts,
      ...(lastObservationError !== undefined
        ? { postActionObservationError: lastObservationError }
        : {}),
    };
  }
}
