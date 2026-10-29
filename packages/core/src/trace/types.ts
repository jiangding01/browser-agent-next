import type { RuntimeErrorCode } from "../errors/codes.js";
import type { CoverageStatus, Ref, RevisionId } from "../state/types.js";

export const TRACE_SCHEMA_VERSION = 1;

export const DECISION_SOURCES = [
  "recipe",
  "webmcp",
  "deterministic",
  "jev",
  "llm",
  "vision",
  "human",
] as const;

export type DecisionSource = (typeof DECISION_SOURCES)[number];

export const RUNTIME_TRACE_EVENT_KINDS = [
  "observe",
  "candidate",
  "decision",
  "policy",
  "preflight",
  "action",
  "effect",
  "verify",
  "escalate",
  "finish",
] as const;

export type RuntimeTraceEventKind = (typeof RUNTIME_TRACE_EVENT_KINDS)[number];

/** model-facing 工具名；与 MODEL_FACING_TOOL_NAMES 一致（由 mcp-server 测试固定）。 */
export const TRACE_TOOL_NAMES = [
  "browser.open",
  "browser.observe",
  "browser.extract",
  "browser.verify",
  "browser.wait",
  "browser.act",
] as const;

export type TraceToolName = (typeof TRACE_TOOL_NAMES)[number];

export const TRACE_STATUS_OUTCOMES = [
  "ok",
  "executed",
  "verified",
  "not-verified",
  "inconclusive",
  "timed-out",
] as const;

export type TraceOutcome =
  | (typeof TRACE_STATUS_OUTCOMES)[number]
  | RuntimeErrorCode
  | "INTERNAL_ERROR";

export const TRACE_AUTHORIZATION_PATHS = [
  "control-plane-auto",
  "operator",
] as const;

export const TRACE_APPROVAL_OUTCOMES = [
  "approved",
  "rejected",
  "expired",
  "invalidated",
  "cancelled",
  "timeout",
  "client-cancelled",
  "unknown",
] as const;

export interface TraceAuthorization {
  path: (typeof TRACE_AUTHORIZATION_PATHS)[number];
  approval?: (typeof TRACE_APPROVAL_OUTCOMES)[number];
  waitMs?: number;
}

/** 只有数字与 coverage 枚举。 */
export interface RuntimeMetrics {
  latencyMs?: number;
  candidateCount?: number;
  candidateTotalKnown?: number;
  candidateCoverage?: CoverageStatus;
  attempts?: number;
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * 脱敏 trace 事件（schema v1，见 docs/TRACE-EVAL-FOUNDATION.md 与不变量 134）。
 *
 * 只允许运行时生成的标识、枚举、数字与已通过 policy 的 exact origin；
 * 页面文本、字段值、URL path / query、模型输入文本与各类授权 id 都不属于这个契约。
 * 没有自由形式字段：任何新增信息都必须先成为这里的强类型字段。
 */
export interface RuntimeTraceEvent {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  ts: number;
  runId: string;
  sessionId: string;
  seq: number;
  event: RuntimeTraceEventKind;
  source?: DecisionSource;
  tool?: TraceToolName;
  tabId?: number;
  revision?: RevisionId;
  ref?: Ref;
  origin?: string;
  outcome: TraceOutcome;
  metrics?: RuntimeMetrics;
  authorization?: TraceAuthorization;
}
