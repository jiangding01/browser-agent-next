import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import type {
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  canonicalEnterpriseAuthorizationAssertion,
  type EnterpriseAuthorizationEnvelope,
} from "../../protocol/enterpriseAuthorization.js";
import type {
  StrictClickAuthorizationIssuanceService,
  StrictClickAuthorizationResult,
} from "./authorizationIssuanceService.js";
import type {
  EnterpriseAuthorizationPolicy,
  EnterpriseAuthorizationPolicyProvider,
} from "./enterpriseManagedPolicy.js";
import type {
  EnterpriseAssertionReplayStore,
} from "./enterpriseAssertionReplayStore.js";

export interface EnterprisePolicyAuthorizationServiceOptions {
  now?: () => number;
}

function authorizationError(
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "AUTHORIZATION_REQUIRED",
    message,
  );
}

function policyError(
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "POLICY_BLOCKED",
    message,
  );
}

function base64Bytes(
  value: string,
): Uint8Array {
  let decoded: string;

  try {
    decoded = atob(value);
  } catch {
    throw policyError(
      "enterprise public key encoding is invalid",
    );
  }

  const bytes =
    new Uint8Array(
      decoded.length,
    );

  for (
    let index = 0;
    index < decoded.length;
    index += 1
  ) {
    bytes[index] =
      decoded.charCodeAt(index);
  }

  return bytes;
}

function base64UrlBytes(
  value: string,
): Uint8Array {
  const normalized =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padding =
    (4 - (
      normalized.length % 4
    )) % 4;

  return base64Bytes(
    normalized +
    "=".repeat(padding),
  );
}

function exactOrigin(
  value: string,
): string {
  try {
    const url = new URL(value);

    if (
      (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) ||
      url.username ||
      url.password ||
      url.origin !== value
    ) {
      throw new Error(
        "not exact origin",
      );
    }

    return url.origin;
  } catch {
    throw authorizationError(
      "enterprise assertion origin is invalid",
    );
  }
}

async function verifySignature(
  policy:
    EnterpriseAuthorizationPolicy,
  envelope:
    EnterpriseAuthorizationEnvelope,
): Promise<boolean> {
  const publicKeyBytes =
    base64Bytes(
      policy.publicKeySpkiBase64,
    );
  const signature =
    base64UrlBytes(
      envelope.signature,
    );

  // P-256 WebCrypto uses IEEE P1363 r||s: exactly 64 bytes.
  if (signature.byteLength !== 64) {
    return false;
  }

  try {
    const key =
      await crypto.subtle.importKey(
        "spki",
        publicKeyBytes,
        {
          name: "ECDSA",
          namedCurve: "P-256",
        },
        false,
        ["verify"],
      );

    return await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      key,
      signature,
      new TextEncoder().encode(
        canonicalEnterpriseAuthorizationAssertion(
          envelope.assertion,
        ),
      ),
    );
  } catch {
    return false;
  }
}

/**
 * 企业策略授权入口。
 *
 * control-plane 只能转发一个由管理员受管公钥验证的签名 assertion。
 * assertion 在成功验证后持久化单次消费，随后才进入 source-bound
 * enterprise issuer。
 */
export class
EnterprisePolicyAuthorizationService {
  private readonly now:
    () => number;

  constructor(
    private readonly states:
      TabStateStore,
    private readonly policies:
      EnterpriseAuthorizationPolicyProvider,
    private readonly replay:
      EnterpriseAssertionReplayStore,
    private readonly issuance:
      StrictClickAuthorizationIssuanceService,
    options:
      EnterprisePolicyAuthorizationServiceOptions = {},
  ) {
    this.now =
      options.now ?? Date.now;
  }

  async issue(
    envelope:
      EnterpriseAuthorizationEnvelope,
  ): Promise<
    StrictClickAuthorizationResult
  > {
    const policy =
      await this.policies.load();

    if (!policy) {
      throw policyError(
        "enterprise authorization policy is not configured",
      );
    }

    const assertion =
      envelope.assertion;
    const now = this.now();

    if (
      assertion.keyId !==
      policy.keyId
    ) {
      throw authorizationError(
        "enterprise assertion key id is not trusted by managed policy",
      );
    }

    if (
      assertion.expiresAt <=
      assertion.issuedAt ||
      assertion.issuedAt > now ||
      assertion.expiresAt < now
    ) {
      throw authorizationError(
        "enterprise assertion is outside its validity window",
      );
    }

    if (
      assertion.expiresAt -
        assertion.issuedAt >
      policy.maxAssertionLifetimeMs
    ) {
      throw authorizationError(
        "enterprise assertion lifetime exceeds managed policy",
      );
    }

    if (
      now + assertion.grantTtlMs >
      assertion.expiresAt
    ) {
      throw authorizationError(
        "enterprise grant would outlive its signed assertion",
      );
    }

    const signatureValid =
      await verifySignature(
        policy,
        envelope,
      );

    if (!signatureValid) {
      throw authorizationError(
        "enterprise assertion signature is invalid",
      );
    }

    const stored =
      this.states.get(
        assertion.tabId,
        assertion.observedRevision,
      );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "enterprise assertion references an observation that is no longer retained",
      );
    }

    if (
      exactOrigin(
        assertion.origin,
      ) !==
      stored.observation.tab.origin
    ) {
      throw authorizationError(
        "enterprise assertion origin does not match the retained observation",
      );
    }

    const firstUse =
      await this.replay
        .consumeOnce(
          assertion.assertionId,
          assertion.expiresAt,
        );

    if (!firstUse) {
      throw authorizationError(
        "enterprise assertion has already been consumed",
      );
    }

    return this.issuance
      .issueEnterprisePolicy({
        authorizationId:
          assertion.authorizationId,
        tabId: assertion.tabId,
        observedRevision:
          assertion.observedRevision,
        ref: assertion.ref,
        ttlMs:
          assertion.grantTtlMs,
      });
  }
}
