import {
  BrowserRuntimeError,
  type AuthorizationAssurance,
} from "@browser-agent-next/core";
import {
  authorizationAssuranceSatisfies,
  minimumAuthorizationAssurance,
  type AuthorizationGrant,
  type InMemoryAuthorizationStore,
  type MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import type {
  TabStateStore,
} from "@browser-agent-next/runtime";

export interface StrictClickAuthorizationInput {
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  ttlMs: number;
}

export interface StrictClickAuthorizationResult {
  id: string;
  expiresAt: number;
  origin: string;
  assurance: AuthorizationAssurance;
}

export interface StrictClickAuthorizationIssuanceOptions {
  maxAuthorizationTtlMs?: number;
}

const SOURCE_PROOF: Record<
  AuthorizationGrant["source"],
  AuthorizationAssurance
> = {
  "trusted-host": "control-plane",
  "trusted-ui": "operator-approved",
  "enterprise-policy": "enterprise-policy",
};

/**
 * Strict Click 的统一受信签发核心。
 *
 * 外部调用方不能传 assurance/source；每个 public 方法把 provenance 固定在
 * 代码路径上，再统一执行 retained observation、ref、origin、最低 assurance
 * 和 TTL 校验。
 */
export class StrictClickAuthorizationIssuanceService {
  private readonly maxAuthorizationTtlMs: number;

  constructor(
    private readonly states: TabStateStore,
    private readonly authorizations: InMemoryAuthorizationStore,
    private readonly origins: MutableExactOriginAllowlist,
    options: StrictClickAuthorizationIssuanceOptions = {},
  ) {
    this.maxAuthorizationTtlMs =
      options.maxAuthorizationTtlMs ?? 60_000;

    if (
      !Number.isInteger(this.maxAuthorizationTtlMs) ||
      this.maxAuthorizationTtlMs < 1
    ) {
      throw new Error(
        "maxAuthorizationTtlMs must be a positive integer",
      );
    }
  }

  issueControlPlane(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("trusted-host", input);
  }

  issueOperatorApproved(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("trusted-ui", input);
  }

  issueEnterprisePolicy(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("enterprise-policy", input);
  }

  private issue(
    source: AuthorizationGrant["source"],
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    if (
      !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.ttlMs > this.maxAuthorizationTtlMs
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "authorization ttl is outside the allowed range",
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

    const assurance = SOURCE_PROOF[source];
    const requiredAssurance =
      minimumAuthorizationAssurance(
        "unknown",
        stored.observation.tab.ownedBySession,
      );

    if (
      requiredAssurance !== undefined &&
      !authorizationAssuranceSatisfies(
        assurance,
        requiredAssurance,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        source +
          " grant is insufficient for this tab; required assurance: " +
          requiredAssurance,
        {
          requiredAssurance,
          availableAssurance: assurance,
          source,
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
      assurance,
      ttlMs: input.ttlMs,
      singleUse: true,
      source,
    });

    return {
      id: grant.id,
      expiresAt: grant.expiresAt,
      origin: stored.observation.tab.origin,
      assurance: grant.assurance,
    };
  }
}
