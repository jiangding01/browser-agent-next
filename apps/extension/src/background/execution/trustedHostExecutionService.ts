import {
  BrowserRuntimeError,
  type StrictActionArgs,
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
import type {
  EnterprisePolicyAuthorizationService,
} from "./enterprisePolicyAuthorizationService.js";
import type {
  EnterpriseAuthorizationEnvelope,
} from "../../protocol/enterpriseAuthorization.js";

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
  /** 缺省为 click。 */
  action?: StrictActionArgs;
}

export interface TrustedExecuteAndVerifyResult {
  execution: ExecuteStrictClickResult;
  verification: VerificationResult;
  verificationAttempts: number;
  freshRevision?: string;
  postActionObservationError?: string;
}

export interface TrustedOperatorApprovalRequestInput
  extends TrustedAuthorizationInput {
  approvalTtlMs?: number;
}

export interface TrustedHostExecutionServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxVerifyTimeoutMs?: number;
  operatorApprovals?: OperatorApprovalStore;
  enterprisePolicyAuthorization?:
    EnterprisePolicyAuthorizationService;
  maxCancelledAuthorizationIds?: number;
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
  private readonly enterprisePolicyAuthorization:
    EnterprisePolicyAuthorizationService | undefined;
  private readonly maxCancelledAuthorizationIds: number;
  private readonly cancelledAuthorizationIds =
    new Set<string>();

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
    this.enterprisePolicyAuthorization =
      options.enterprisePolicyAuthorization;
    this.maxCancelledAuthorizationIds =
      options.maxCancelledAuthorizationIds ?? 256;

    if (
      !Number.isInteger(
        this.maxCancelledAuthorizationIds,
      ) ||
      this.maxCancelledAuthorizationIds < 1
    ) {
      throw new Error(
        "maxCancelledAuthorizationIds must be a positive integer",
      );
    }
  }

  replaceAutoActOrigins(
    origins: readonly string[],
  ): string[] {
    return this.origins.replace(origins);
  }

  issueStrictClickAuthorization(
    input: TrustedAuthorizationInput,
  ) {
    this.assertNotCancelled(
      input.authorizationId,
    );

    return this.authorizationIssuance
      .issueControlPlane(input);
  }

  requestOperatorApproval(
    input: TrustedOperatorApprovalRequestInput,
  ) {
    if (!this.operatorApprovals) {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "operator approval ingress is unavailable",
      );
    }

    this.assertNotCancelled(
      input.authorizationId,
    );

    return this.operatorApprovals
      .request(input);
  }

  /**
   * 撤销 authorizationId 对应的 pending approval 与未消费 grant（任意来源）。
   *
   * 先记 tombstone，迟到的同 id issue / request 会被拒绝；撤销只减少能力，
   * 已消费的 grant 不受影响，因此成功返回不代表点击被阻止。
   */
  cancelStrictClickAuthorization(
    authorizationId: string,
  ): { authorizationId: string } {
    this.cancelledAuthorizationIds.delete(
      authorizationId,
    );
    this.cancelledAuthorizationIds.add(
      authorizationId,
    );

    while (
      this.cancelledAuthorizationIds.size >
      this.maxCancelledAuthorizationIds
    ) {
      const oldest =
        this.cancelledAuthorizationIds
          .values()
          .next()
          .value as string | undefined;

      if (oldest === undefined) {
        break;
      }

      this.cancelledAuthorizationIds.delete(
        oldest,
      );
    }

    const grantRevoked =
      this.authorizationIssuance.revoke(
        authorizationId,
      );

    this.operatorApprovals
      ?.cancelByAuthorizationId(
        authorizationId,
        grantRevoked,
      );

    return { authorizationId };
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

  private assertNotCancelled(
    authorizationId: string,
  ): void {
    if (
      this.cancelledAuthorizationIds.has(
        authorizationId,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "authorization id was cancelled",
      );
    }
  }

  async issueEnterprisePolicyAuthorization(
    envelope: EnterpriseAuthorizationEnvelope,
  ) {
    if (!this.enterprisePolicyAuthorization) {
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "enterprise policy authorization ingress is unavailable",
      );
    }

    this.assertNotCancelled(
      envelope.assertion.authorizationId,
    );

    return this.enterprisePolicyAuthorization
      .issue(envelope);
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
        ...(input.action !== undefined
          ? { action: input.action }
          : {}),
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
