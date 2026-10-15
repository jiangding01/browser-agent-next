import {
  BrowserRuntimeError,
  type BrowserObserveInput,
  type BrowserObserveOptions,
  type BrowserOpenInput,
  type BrowserVerifyInput,
  type BrowserWaitInput,
  type VerificationSpec,
  type VerifyCondition,
} from "@browser-agent-next/core";

export const MODEL_INPUT_LIMITS = {
  maxString: 2_048,
  maxRefLength: 256,
  maxRefs: 100,
  maxVerifyConditions: 20,
  maxWaitMs: 30_000,
  minPollMs: 50,
  maxPollMs: 1_000,
  maxObserveElements: 500,
  maxActVerifyTimeoutMs: 5_000,
} as const;

export interface ModelExtractInput {
  tabId: number;
  observedRevision: string;
  refs?: string[];
  maxItems?: number;
}

/**
 * model-facing browser.act 入参。
 *
 * 只描述“想点哪个已出境 ref、如何验证”；authorizationId / actionId /
 * assurance / source 等授权与执行身份字段只能由 MCP 进程内的 broker 生成，
 * 模型传入即拒绝。
 */
export interface ModelActInput {
  tabId: number;
  observedRevision: string;
  ref: string;
  kind: "click";
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}

function objectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedString(
  value: unknown,
  max: number = MODEL_INPUT_LIMITS.maxString,
): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max;
}

function tabId(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max;
}

function optionalFiniteNumber(
  value: unknown,
  min: number,
  max: number,
): boolean {
  return value === undefined || (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isBoundedJsonValue(
  value: unknown,
  depth = 0,
  budget = { remaining: 100 },
): boolean {
  if (budget.remaining <= 0 || depth > 5) return false;
  budget.remaining -= 1;

  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return value.length <= MODEL_INPUT_LIMITS.maxString;
  }
  if (Array.isArray(value)) {
    return value.length <= 50 &&
      value.every((item) =>
        isBoundedJsonValue(item, depth + 1, budget)
      );
  }

  const record = objectRecord(value);
  if (!record) return false;
  const entries = Object.entries(record);
  return entries.length <= 50 &&
    entries.every(([key, item]) =>
      key.length <= 128 &&
      isBoundedJsonValue(item, depth + 1, budget)
    );
}

export function isModelObserveOptions(
  value: unknown,
): value is BrowserObserveOptions {
  if (value === undefined) return true;
  const options = objectRecord(value);
  if (!options) return false;
  if (!hasOnlyKeys(options, [
    "profile",
    "maxElements",
    "maxAxElements",
    "includeValues",
    "includeOpenShadowRoots",
  ])) {
    return false;
  }

  return (
    (options.profile === undefined ||
      options.profile === "dom" ||
      options.profile === "hybrid") &&
    (options.maxElements === undefined ||
      boundedInteger(
        options.maxElements,
        1,
        MODEL_INPUT_LIMITS.maxObserveElements,
      )) &&
    (options.maxAxElements === undefined ||
      boundedInteger(
        options.maxAxElements,
        1,
        MODEL_INPUT_LIMITS.maxObserveElements,
      )) &&
    (options.includeValues === undefined ||
      typeof options.includeValues === "boolean") &&
    (options.includeOpenShadowRoots === undefined ||
      typeof options.includeOpenShadowRoots === "boolean")
  );
}

function isVerifyCondition(
  value: unknown,
): value is VerifyCondition {
  const condition = objectRecord(value);
  if (!condition || typeof condition.type !== "string") {
    return false;
  }

  switch (condition.type) {
    case "url_matches":
    case "title_matches":
      return hasOnlyKeys(condition, ["type", "pattern"]) &&
        boundedString(condition.pattern);

    case "ref_exists":
    case "ref_visible":
    case "ref_absent":
      return hasOnlyKeys(condition, ["type", "ref"]) &&
        boundedString(
          condition.ref,
          MODEL_INPUT_LIMITS.maxRefLength,
        );

    case "text_present":
      return hasOnlyKeys(
        condition,
        ["type", "text", "scopeRef"],
      ) &&
        boundedString(condition.text) &&
        (
          condition.scopeRef === undefined ||
          boundedString(
            condition.scopeRef,
            MODEL_INPUT_LIMITS.maxRefLength,
          )
        );

    case "field_value":
      return hasOnlyKeys(
        condition,
        ["type", "ref", "equals"],
      ) &&
        boundedString(
          condition.ref,
          MODEL_INPUT_LIMITS.maxRefLength,
        ) &&
        isBoundedJsonValue(condition.equals);

    case "dialog_present":
      return hasOnlyKeys(condition, ["type", "title"]) &&
        (
          condition.title === undefined ||
          (
            typeof condition.title === "string" &&
            condition.title.length <= MODEL_INPUT_LIMITS.maxString
          )
        );

    case "download_started":
      return hasOnlyKeys(
        condition,
        ["type", "filenamePattern"],
      ) &&
        (
          condition.filenamePattern === undefined ||
          (
            typeof condition.filenamePattern === "string" &&
            condition.filenamePattern.length <= MODEL_INPUT_LIMITS.maxString
          )
        );

    case "network_request_completed":
      return hasOnlyKeys(condition, ["type", "urlPattern"]) &&
        boundedString(condition.urlPattern);

    default:
      return false;
  }
}

export function isModelVerificationSpec(
  value: unknown,
): value is VerificationSpec {
  const spec = objectRecord(value);
  return !!spec &&
    hasOnlyKeys(spec, ["mode", "conditions"]) &&
    (spec.mode === "all" || spec.mode === "any") &&
    Array.isArray(spec.conditions) &&
    spec.conditions.length > 0 &&
    spec.conditions.length <= MODEL_INPUT_LIMITS.maxVerifyConditions &&
    spec.conditions.every(isVerifyCondition);
}

export function parseModelOpenInput(
  value: unknown,
): BrowserOpenInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(input, ["url", "active"]) ||
    !boundedString(input.url) ||
    (
      input.active !== undefined &&
      typeof input.active !== "boolean"
    )
  ) {
    throw invalidInput("browser.open");
  }

  return {
    url: input.url,
    ...(input.active !== undefined
      ? { active: input.active }
      : {}),
  };
}

export function parseModelObserveInput(
  value: unknown,
): BrowserObserveInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(
      input,
      ["tabId", "sinceRevision", "options"],
    ) ||
    !tabId(input.tabId) ||
    (
      input.sinceRevision !== undefined &&
      !boundedString(
        input.sinceRevision,
        MODEL_INPUT_LIMITS.maxRefLength,
      )
    ) ||
    !isModelObserveOptions(input.options)
  ) {
    throw invalidInput("browser.observe");
  }

  return {
    tabId: input.tabId,
    ...(input.sinceRevision !== undefined
      ? { sinceRevision: input.sinceRevision }
      : {}),
    ...(input.options !== undefined
      ? { options: input.options }
      : {}),
  };
}

export function parseModelExtractInput(
  value: unknown,
): ModelExtractInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(
      input,
      ["tabId", "observedRevision", "refs", "maxItems"],
    ) ||
    !tabId(input.tabId) ||
    !boundedString(
      input.observedRevision,
      MODEL_INPUT_LIMITS.maxRefLength,
    ) ||
    (
      input.refs !== undefined &&
      (
        !Array.isArray(input.refs) ||
        input.refs.length < 1 ||
        input.refs.length > MODEL_INPUT_LIMITS.maxRefs ||
        !input.refs.every((ref) =>
          boundedString(
            ref,
            MODEL_INPUT_LIMITS.maxRefLength,
          )
        )
      )
    ) ||
    (
      input.maxItems !== undefined &&
      !boundedInteger(
        input.maxItems,
        1,
        MODEL_INPUT_LIMITS.maxRefs,
      )
    )
  ) {
    throw invalidInput("browser.extract");
  }

  return {
    tabId: input.tabId,
    observedRevision: input.observedRevision,
    ...(input.refs !== undefined
      ? { refs: [...input.refs] as string[] }
      : {}),
    ...(input.maxItems !== undefined
      ? { maxItems: input.maxItems }
      : {}),
  };
}

export function parseModelVerifyInput(
  value: unknown,
): BrowserVerifyInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(
      input,
      ["tabId", "observedRevision", "verification"],
    ) ||
    !tabId(input.tabId) ||
    !boundedString(
      input.observedRevision,
      MODEL_INPUT_LIMITS.maxRefLength,
    ) ||
    !isModelVerificationSpec(input.verification)
  ) {
    throw invalidInput("browser.verify");
  }

  return {
    tabId: input.tabId,
    observedRevision: input.observedRevision,
    verification: input.verification,
  };
}

export function parseModelWaitInput(
  value: unknown,
): BrowserWaitInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(
      input,
      [
        "tabId",
        "verification",
        "timeoutMs",
        "pollIntervalMs",
        "options",
      ],
    ) ||
    !tabId(input.tabId) ||
    !isModelVerificationSpec(input.verification) ||
    !optionalFiniteNumber(
      input.timeoutMs,
      0,
      MODEL_INPUT_LIMITS.maxWaitMs,
    ) ||
    (
      input.pollIntervalMs !== undefined &&
      !boundedInteger(
        input.pollIntervalMs,
        MODEL_INPUT_LIMITS.minPollMs,
        MODEL_INPUT_LIMITS.maxPollMs,
      )
    ) ||
    !isModelObserveOptions(input.options)
  ) {
    throw invalidInput("browser.wait");
  }

  return {
    tabId: input.tabId,
    verification: input.verification,
    ...(input.timeoutMs !== undefined
      ? { timeoutMs: input.timeoutMs as number }
      : {}),
    ...(input.pollIntervalMs !== undefined
      ? { pollIntervalMs: input.pollIntervalMs as number }
      : {}),
    ...(input.options !== undefined
      ? { options: input.options }
      : {}),
  };
}

export function parseModelActInput(
  value: unknown,
): ModelActInput {
  const input = objectRecord(value);
  if (
    !input ||
    !hasOnlyKeys(
      input,
      [
        "tabId",
        "observedRevision",
        "ref",
        "kind",
        "verification",
        "verifyTimeoutMs",
      ],
    ) ||
    !tabId(input.tabId) ||
    !boundedString(
      input.observedRevision,
      MODEL_INPUT_LIMITS.maxRefLength,
    ) ||
    !boundedString(
      input.ref,
      MODEL_INPUT_LIMITS.maxRefLength,
    ) ||
    input.kind !== "click" ||
    !isModelVerificationSpec(input.verification) ||
    !optionalFiniteNumber(
      input.verifyTimeoutMs,
      0,
      MODEL_INPUT_LIMITS.maxActVerifyTimeoutMs,
    )
  ) {
    throw invalidInput("browser.act");
  }

  return {
    tabId: input.tabId,
    observedRevision: input.observedRevision,
    ref: input.ref,
    kind: "click",
    verification: input.verification,
    ...(input.verifyTimeoutMs !== undefined
      ? { verifyTimeoutMs: input.verifyTimeoutMs as number }
      : {}),
  };
}

function invalidInput(tool: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "POLICY_BLOCKED",
    tool + " rejected invalid or unbounded model input",
  );
}
