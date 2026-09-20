export interface EnterpriseAuthorizationAssertion {
  version: 1;
  assertionId: string;
  keyId: string;
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  origin: string;
  actionKind: "click";
  effectClass: "unknown";
  issuedAt: number;
  expiresAt: number;
  grantTtlMs: number;
}

export interface EnterpriseAuthorizationEnvelope {
  assertion: EnterpriseAuthorizationAssertion;
  signature: string;
}

function record(
  value: unknown,
): Record<string, unknown> | undefined {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value)
    .every((key) => keys.has(key));
}

function boundedString(
  value: unknown,
  max: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max
  );
}

function safeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function exactHttpOrigin(
  value: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048
  ) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      (
        url.protocol === "http:" ||
        url.protocol === "https:"
      ) &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export function
isEnterpriseAuthorizationAssertion(
  value: unknown,
): value is EnterpriseAuthorizationAssertion {
  const assertion = record(value);

  if (
    !assertion ||
    !hasOnlyKeys(
      assertion,
      [
        "version",
        "assertionId",
        "keyId",
        "authorizationId",
        "tabId",
        "observedRevision",
        "ref",
        "origin",
        "actionKind",
        "effectClass",
        "issuedAt",
        "expiresAt",
        "grantTtlMs",
      ],
    )
  ) {
    return false;
  }

  return (
    assertion.version === 1 &&
    boundedString(
      assertion.assertionId,
      256,
    ) &&
    boundedString(
      assertion.keyId,
      128,
    ) &&
    boundedString(
      assertion.authorizationId,
      256,
    ) &&
    typeof assertion.tabId === "number" &&
    Number.isInteger(assertion.tabId) &&
    assertion.tabId >= 0 &&
    boundedString(
      assertion.observedRevision,
      256,
    ) &&
    boundedString(
      assertion.ref,
      256,
    ) &&
    exactHttpOrigin(assertion.origin) &&
    assertion.actionKind === "click" &&
    assertion.effectClass === "unknown" &&
    safeInteger(assertion.issuedAt) &&
    safeInteger(assertion.expiresAt) &&
    safeInteger(assertion.grantTtlMs) &&
    assertion.grantTtlMs >= 1 &&
    assertion.grantTtlMs <= 60_000
  );
}

export function
isEnterpriseAuthorizationEnvelope(
  value: unknown,
): value is EnterpriseAuthorizationEnvelope {
  const envelope = record(value);

  return !!envelope &&
    hasOnlyKeys(
      envelope,
      ["assertion", "signature"],
    ) &&
    isEnterpriseAuthorizationAssertion(
      envelope.assertion,
    ) &&
    boundedString(
      envelope.signature,
      256,
    ) &&
    /^[A-Za-z0-9_-]+$/.test(
      envelope.signature,
    );
}

/**
 * 企业签名的 canonical payload。
 *
 * 字段顺序固定；签名方必须对该 UTF-8 JSON 字节串签名。
 * 不接受 caller-defined extra fields。
 */
export function
canonicalEnterpriseAuthorizationAssertion(
  assertion:
    EnterpriseAuthorizationAssertion,
): string {
  return JSON.stringify({
    version: assertion.version,
    assertionId:
      assertion.assertionId,
    keyId: assertion.keyId,
    authorizationId:
      assertion.authorizationId,
    tabId: assertion.tabId,
    observedRevision:
      assertion.observedRevision,
    ref: assertion.ref,
    origin: assertion.origin,
    actionKind:
      assertion.actionKind,
    effectClass:
      assertion.effectClass,
    issuedAt: assertion.issuedAt,
    expiresAt:
      assertion.expiresAt,
    grantTtlMs:
      assertion.grantTtlMs,
  });
}
