import { RUNTIME_ERROR_CODES } from "../errors/codes.js";
import {
  DECISION_SOURCES,
  RUNTIME_TRACE_EVENT_KINDS,
  TRACE_APPROVAL_OUTCOMES,
  TRACE_AUTHORIZATION_PATHS,
  TRACE_SCHEMA_VERSION,
  TRACE_STATUS_OUTCOMES,
  TRACE_TOOL_NAMES,
  type RuntimeTraceEvent,
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REF_PATTERN = /^@[a-z]{1,8}_[0-9A-Z]{1,16}$/;
const MAX_ORIGIN_LENGTH = 300;
const MAX_TAB_ID = 2 ** 31 - 1;
const MAX_TS = 1e14;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 1e9;

const EVENT_KEYS = new Set([
  "schemaVersion",
  "ts",
  "runId",
  "sessionId",
  "seq",
  "event",
  "source",
  "tool",
  "tabId",
  "revision",
  "ref",
  "origin",
  "outcome",
  "metrics",
  "authorization",
]);
const METRIC_KEYS = new Set([
  "latencyMs",
  "candidateCount",
  "candidateTotalKnown",
  "candidateCoverage",
  "attempts",
  "confidence",
  "inputTokens",
  "outputTokens",
  "costUsd",
]);
const AUTHORIZATION_KEYS = new Set(["path", "approval", "waitMs"]);
const COVERAGE_STATUSES = ["complete", "truncated", "partial", "unknown"];
const OUTCOMES: readonly string[] = [
  ...TRACE_STATUS_OUTCOMES,
  ...RUNTIME_ERROR_CODES,
  "INTERNAL_ERROR",
];

function isMember(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isTraceTabId(value: unknown): value is number {
  return isIntegerIn(value, 0, MAX_TAB_ID);
}

export function isTraceRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION_PATTERN.test(value);
}

export function isTraceRef(value: unknown): value is string {
  return typeof value === "string" && REF_PATTERN.test(value);
}

/** exact http(s) origin：没有 path、query、fragment 与 credentials。 */
export function isTraceOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isValidMetrics(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, METRIC_KEYS)) return false;

  const counts = ["candidateCount", "candidateTotalKnown", "attempts", "inputTokens", "outputTokens"];
  for (const key of counts) {
    if (value[key] !== undefined && !isIntegerIn(value[key], 0, MAX_COUNT)) return false;
  }
  if (value.latencyMs !== undefined && !isIntegerIn(value.latencyMs, 0, MAX_DURATION_MS)) {
    return false;
  }
  if (
    value.candidateCoverage !== undefined &&
    !isMember(COVERAGE_STATUSES, value.candidateCoverage)
  ) {
    return false;
  }
  const confidence = value.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))
  ) {
    return false;
  }
  const cost = value.costUsd;
  if (cost !== undefined && (typeof cost !== "number" || !(cost >= 0 && cost <= 1e6))) {
    return false;
  }
  return true;
}

function isValidAuthorization(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, AUTHORIZATION_KEYS) &&
    isMember(TRACE_AUTHORIZATION_PATHS, value.path) &&
    (value.approval === undefined || isMember(TRACE_APPROVAL_OUTCOMES, value.approval)) &&
    (value.waitMs === undefined || isIntegerIn(value.waitMs, 0, MAX_DURATION_MS))
  );
}

/**
 * trace 事件的第二道防线（不变量 134）：exact-key + 格式白名单。
 *
 * 构造方本应只产生合法事件；不合法的事件必须整条丢弃，而不是修剪后写出。
 */
export function validateTraceEvent(value: unknown): value is RuntimeTraceEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, EVENT_KEYS)) return false;

  return (
    value.schemaVersion === TRACE_SCHEMA_VERSION &&
    isIntegerIn(value.ts, 0, MAX_TS) &&
    isTraceId(value.runId) &&
    isTraceId(value.sessionId) &&
    isIntegerIn(value.seq, 1, Number.MAX_SAFE_INTEGER) &&
    isMember(RUNTIME_TRACE_EVENT_KINDS, value.event) &&
    (value.source === undefined || isMember(DECISION_SOURCES, value.source)) &&
    (value.tool === undefined || isMember(TRACE_TOOL_NAMES, value.tool)) &&
    (value.tabId === undefined || isTraceTabId(value.tabId)) &&
    (value.revision === undefined || isTraceRevision(value.revision)) &&
    (value.ref === undefined || isTraceRef(value.ref)) &&
    (value.origin === undefined || isTraceOrigin(value.origin)) &&
    isMember(OUTCOMES, value.outcome) &&
    (value.metrics === undefined || isValidMetrics(value.metrics)) &&
    (value.authorization === undefined || isValidAuthorization(value.authorization))
  );
}
