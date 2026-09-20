import {
  BrowserRuntimeError,
  type VerificationResult,
  type VerificationSpec,
} from "@browser-agent-next/core";
import type {
  MutableExactOriginAllowlist,
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
import type {
  StrictClickAuthorizationInput,
  StrictClickAuthorizationIssuanceService,
} from "./authorizationIssuanceService.js";
import type {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

export type TrustedAuthorizationInput =
  StrictClickAuthorizationInput;

export interface TrustedExecuteAndVerifyInput {
  actionId: string;
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}

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
  operatorApprovals?: OperatorApprovalStore;
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
  private readonly operatorApprovals:
    OperatorApprovalStore | undefined;

  constructor(
    private readonly states: TabStateStore,
    private readonly origins:
      MutableExactOriginAllowlist,
    private readonly authorizationIssuance:
      StrictClickAuthorizationIssuanceService,
    private readonly executor:
      PolicyGatedStrictClickExecutor,
    private readonly observations:
      ChromeDomObservationService,
    options:
      TrustedHostExecutionServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise(
        (resolve) => setTimeout(resolve, ms),
      )
    );
    this.pollIntervalMs =
      options.pollIntervalMs ?? 100;
    this.maxVerifyTimeoutMs =
      options.maxVerifyTimeoutMs ?? 5_000;
    this.operatorApprovals =
      options.operatorApprovals;
  }

  replaceAutoActOrigins(
    origins: readonly string[],
  ): string[] {
    return this.origins.replace(origins);
  }

  issueStrictClickAuthorization(
    input: TrustedAuthorizationInput,
  ) {
    return this.authorizationIssuance
      .issueControlPlane(input);
  }

  requestOperatorApproval(
    input: TrustedAuthorizationInput,
  ) {
    if (!this.operatorApprovals) {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "operator approval ingress is unavailable",
      );
    }

    return this.operatorApprovals
      .request(input);
  }

  operatorApprovalStatus(
    approvalRequestId: string,
  ) {
    if (!this.operatorApprovals) {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "operator approval ingress is unavailable",
      );
    }

    return this.operatorApprovals
      .status(approvalRequestId);
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

    const execution =
      await this.executor.execute({
        tabId: input.tabId,
        actionId: input.actionId,
        observedRevision:
          input.observedRevision,
        ref: input.ref,
        authorizationId:
          input.authorizationId,
      });

    const requestedTimeout =
      input.verifyTimeoutMs ?? 1_500;
    const timeoutMs = Math.max(
      0,
      Math.min(
        requestedTimeout,
        this.maxVerifyTimeoutMs,
      ),
    );
    const deadline =
      this.now() + timeoutMs;

    let attempts = 0;
    let lastObservationError:
      string | undefined;

    do {
      attempts += 1;

      try {
        const fresh =
          await this.observations.observe({
            tabId: input.tabId,
            ownedBySession:
              baseline.observation.tab
                .ownedBySession,
            options: {
              includeAx: true,
            },
          });

        const verification =
          verifyObservation(
            fresh,
            input.verification,
          );

        if (
          verification.conclusive ||
          this.now() >= deadline
        ) {
          return {
            execution,
            verification,
            verificationAttempts:
              attempts,
            freshRevision:
              fresh.revision.id,
          };
        }
      } catch (error) {
        // 这里只重试 observation/verification，绝不重放 click。
        lastObservationError =
          boundedError(error);
      }

      if (this.now() >= deadline) {
        break;
      }

      await this.sleep(
        Math.min(
          this.pollIntervalMs,
          Math.max(
            0,
            deadline - this.now(),
          ),
        ),
      );
    } while (this.now() <= deadline);

    return {
      execution,
      verification:
        inconclusiveVerification(
          input.verification,
          lastObservationError
            ? "post-action observation remained unavailable: " +
              lastObservationError
            : "verification remained inconclusive before timeout",
        ),
      verificationAttempts: attempts,
      ...(lastObservationError !==
      undefined
        ? {
            postActionObservationError:
              lastObservationError,
          }
        : {}),
    };
  }
}
