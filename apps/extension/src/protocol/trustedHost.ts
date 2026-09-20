import type {
  BrowserActInput,
  BrowserObserveOptions,
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
    }
  | {
      type: "browser.observe";
      requestId: string;
      tabId: number;
      sinceRevision?: string;
      options?: BrowserObserveOptions;
    }
  | {
      type: "browser.verify";
      requestId: string;
      tabId: number;
      observedRevision: string;
      verification: VerificationSpec;
    }
  | {
      type: "browser.wait";
      requestId: string;
      tabId: number;
      verification: VerificationSpec;
      timeoutMs?: number;
      pollIntervalMs?: number;
      options?: BrowserObserveOptions;
    }
  | {
      type: "browser.act";
      requestId: string;
      tabId: number;
      action: BrowserActInput["action"];
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

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function optionalFiniteNumber(
  value: unknown,
  min: number,
  max: number,
): boolean {
  return (
    value === undefined ||
    (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max
    )
  );
}

function isObserveOptions(
  value: unknown,
): value is BrowserObserveOptions {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const options = value as Record<string, unknown>;
  return (
    (options.profile === undefined || options.profile === "dom" || options.profile === "hybrid") &&
    (options.maxElements === undefined || boundedInteger(options.maxElements, 1, 500)) &&
    (options.maxAxElements === undefined || boundedInteger(options.maxAxElements, 1, 500)) &&
    (options.includeValues === undefined || typeof options.includeValues === "boolean") &&
    (options.includeOpenShadowRoots === undefined || typeof options.includeOpenShadowRoots === "boolean")
  );
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
      return nonEmptyString(condition.text) &&
        (condition.scopeRef === undefined || nonEmptyString(condition.scopeRef));
    case "field_value":
      return nonEmptyString(condition.ref);
    case "dialog_present":
      return condition.title === undefined || typeof condition.title === "string";
    case "download_started":
      return condition.filenamePattern === undefined || typeof condition.filenamePattern === "string";
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

function isBrowserActAction(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const action = value as Record<string, unknown>;
  return (
    action.kind === "click" &&
    nonEmptyString(action.actionId) &&
    nonEmptyString(action.observedRevision) &&
    nonEmptyString(action.ref) &&
    nonEmptyString(action.authorizationId) &&
    action.assurance === undefined
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
      return Array.isArray(request.origins) &&
        request.origins.length <= 100 &&
        request.origins.every(nonEmptyString);

    case "authorization.issue-strict-click":
      return request.assurance === undefined &&
        nonEmptyString(request.authorizationId) &&
        tabId(request.tabId) &&
        nonEmptyString(request.observedRevision) &&
        nonEmptyString(request.ref) &&
        optionalFiniteNumber(request.ttlMs, 1, 60_000) &&
        request.ttlMs !== undefined;

    case "execution.execute-strict-click":
      return nonEmptyString(request.actionId) &&
        nonEmptyString(request.authorizationId) &&
        tabId(request.tabId) &&
        nonEmptyString(request.observedRevision) &&
        nonEmptyString(request.ref) &&
        isVerificationSpec(request.verification) &&
        optionalFiniteNumber(request.verifyTimeoutMs, 0, 5_000);

    case "browser.observe":
      return tabId(request.tabId) &&
        (request.sinceRevision === undefined || nonEmptyString(request.sinceRevision)) &&
        isObserveOptions(request.options);

    case "browser.verify":
      return tabId(request.tabId) &&
        nonEmptyString(request.observedRevision) &&
        isVerificationSpec(request.verification);

    case "browser.wait":
      return tabId(request.tabId) &&
        isVerificationSpec(request.verification) &&
        optionalFiniteNumber(request.timeoutMs, 0, 30_000) &&
        (request.pollIntervalMs === undefined || boundedInteger(request.pollIntervalMs, 50, 1000)) &&
        isObserveOptions(request.options);

    case "browser.act":
      return tabId(request.tabId) &&
        isBrowserActAction(request.action) &&
        isVerificationSpec(request.verification) &&
        optionalFiniteNumber(request.verifyTimeoutMs, 0, 5_000);

    default:
      return false;
  }
}
