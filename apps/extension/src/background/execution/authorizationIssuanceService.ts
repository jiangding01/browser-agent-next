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

export interface IssuedStrictClickAuthorization {
  id: string;
  expiresAt: number;
  origin: string;
  assurance: AuthorizationAssurance;
}

export interface AuthorizationIssuanceServiceOptions {
  maxAuthorizationTtlMs?: number;
}

interface AuthorizationIssuerIdentity {
  source: AuthorizationGrant["source"];
  assurance: AuthorizationAssurance;
}

/**
 * 统一的受信授权签发核心。
 *
 * 外部 ingress 只能调用固定 assurance 的专用方法，不能把 source/assurance
 * 当作普通参数传入。真正的共享校验留在 private issueStrictClick() 内。
 */
export class AuthorizationIssuanceService {
  private readonly maxAuthorizationTtlMs: number;

  constructor(
    private readonly states: TabStateStore,
    private readonly authorizations: InMemoryAuthorizationStore,
    private readonly origins: MutableExactOriginAllowlist,
    options: AuthorizationIssuanceServiceOptions = {},
  ) {
    this.maxAuthorizationTtlMs =
      options.maxAuthorizationTtlMs ?? 60_000;

    if (
      !Number.isFinite(this.maxAuthorizationTtlMs) ||
      this.maxAuthorizationTtlMs <= 0
    ) {
      throw new Error(
        "maxAuthorizationTtlMs must be > 0",
      );
    }
  }

  issueControlPlaneStrictClick(
    input: StrictClickAuthorizationInput,
  ): IssuedStrictClickAuthorization {
    return this.issueStrictClick(
      input,
      {
        source: "trusted-host",
        assurance: "control-plane",
      },
    );
  }

  issueOperatorApprovedStrictClick(
    input: StrictClickAuthorizationInput,
  ): IssuedStrictClickAuthorization {
    return this.issueStrictClick(
      input,
      {
        source: "trusted-ui",
        assurance: "operator-approved",
      },
    );
  }

  issueEnterprisePolicyStrictClick(
    input: StrictClickAuthorizationInput,
  ): IssuedStrictClickAuthorization {
    return this.issueStrictClick(
      input,
      {
        source: "enterprise-policy",
        assurance: "enterprise-policy",
      },
    );
  }

  private issueStrictClick(
    input: StrictClickAuthorizationInput,
    issuer: AuthorizationIssuerIdentity,
  ): IssuedStrictClickAuthorization {
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

    if (
      !this.origins.isAllowed(
        stored.observation.tab.origin,
      )
    ) {
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
        issuer.assurance,
        requiredAssurance,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "authorization issuer assurance is insufficient for this tab; required assurance: " +
          requiredAssurance,
        {
          requiredAssurance,
          availableAssurance: issuer.assurance,
          source: issuer.source,
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
      assurance: issuer.assurance,
      ttlMs: input.ttlMs,
      singleUse: true,
      source: issuer.source,
    });

    return {
      id: grant.id,
      expiresAt: grant.expiresAt,
      origin: stored.observation.tab.origin,
      assurance: grant.assurance,
    };
  }
}
