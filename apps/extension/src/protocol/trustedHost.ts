import type {
  VerificationSpec,
  VerifyCondition,
} from "@browser-agent-next/core";

export const TRUSTED_NATIVE_HOST_NAME =
  "com.browser_agent_next.host";

export type TrustedHostRequest =
  | {
      type: "policy.replace-autoact-origins";
      requestId: string;
      origins: string[];
    }
  | {
      type: "authorization.issue-strict-click";
      requestId: string;
      authorizationId: string;
      tabId: number;
      observedRevision: string;
      ref: string;
      ttlMs: number;
    }
  | {
      type: "execution.execute-strict-click";
      requestId: string;
      actionId: string;
      authorizationId: string;
      tabId: number;
      observedRevision: string;
      ref: string;
      verification: VerificationSpec;
      verifyTimeoutMs?: number;
    };

export type TrustedHostResponse =
  | {
      type: "trusted-host.result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "trusted-host.result";
      requestId: string;
      ok: false;
      error: {
        code: string;
        message: string;
        outcomeMayHaveChanged?: boolean;
      };
    };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function tabId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isVerifyCondition(
  value: unknown,
): value is VerifyCondition {
  if (typeof value !== "object" || value === null) return false;
  const condition = value as Record<string, unknown>;

  switch (condition.type) {
    case "url_matches":
    case "title_matches":
      return nonEmptyString(condition.pattern);

    case "ref_exists":
    case "ref_visible":
    case "ref_absent":
      return nonEmptyString(condition.ref);

    case "text_present":
      return (
        nonEmptyString(condition.text) &&
        (
          condition.scopeRef === undefined ||
          nonEmptyString(condition.scopeRef)
        )
      );

    case "field_value":
      return nonEmptyString(condition.ref);

    case "dialog_present":
      return (
        condition.title === undefined ||
        typeof condition.title === "string"
      );

    case "download_started":
      return (
        condition.filenamePattern === undefined ||
        typeof condition.filenamePattern === "string"
      );

    case "network_request_completed":
      return nonEmptyString(condition.urlPattern);

    default:
      return false;
  }
}

function isVerificationSpec(
  value: unknown,
): value is VerificationSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Record<string, unknown>;

  return (
    (spec.mode === "all" || spec.mode === "any") &&
    Array.isArray(spec.conditions) &&
    spec.conditions.length > 0 &&
    spec.conditions.length <= 20 &&
    spec.conditions.every(isVerifyCondition)
  );
}

export function isTrustedHostRequest(
  value: unknown,
): value is TrustedHostRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;

  if (!nonEmptyString(request.requestId)) return false;

  switch (request.type) {
    case "policy.replace-autoact-origins":
      return (
        Array.isArray(request.origins) &&
        request.origins.length <= 100 &&
        request.origins.every(nonEmptyString)
      );

    case "authorization.issue-strict-click":
      return (
        nonEmptyString(request.authorizationId) &&
        tabId(request.tabId) &&
        nonEmptyString(request.observedRevision) &&
        nonEmptyString(request.ref) &&
        typeof request.ttlMs === "number" &&
        Number.isFinite(request.ttlMs)
      );

    case "execution.execute-strict-click":
      return (
        nonEmptyString(request.actionId) &&
        nonEmptyString(request.authorizationId) &&
        tabId(request.tabId) &&
        nonEmptyString(request.observedRevision) &&
        nonEmptyString(request.ref) &&
        isVerificationSpec(request.verification) &&
        (
          request.verifyTimeoutMs === undefined ||
          (
            typeof request.verifyTimeoutMs === "number" &&
            Number.isFinite(request.verifyTimeoutMs)
          )
        )
      );

    default:
      return false;
  }
}
