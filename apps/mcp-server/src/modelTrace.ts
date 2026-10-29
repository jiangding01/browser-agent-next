import { randomUUID } from "node:crypto";
import {
  BrowserRuntimeError,
  TRACE_SCHEMA_VERSION,
  isTraceOrigin,
  isTraceRef,
  isTraceRevision,
  isTraceTabId,
  validateTraceEvent,
  type RuntimeMetrics,
  type RuntimeTraceEvent,
  type RuntimeTraceEventKind,
  type TraceAuthorization,
  type TraceOutcome,
} from "@browser-agent-next/core";
import type {
  ModelFacingToolName,
} from "@browser-agent-next/policy";
import type { TraceSink } from "./traceFileSink.js";

/**
 * 一次 tool call 的原始结果，由 bridge 交给 session 构造 trace 事件。
 *
 * input / value 来自模型与 adapter，这里只按 docs/TRACE-EVAL-FOUNDATION.md
 * 「事件构造」表读取运行时标识、枚举与数字（不变量 134）。
 */
export interface TracedToolCall {
  tool: ModelFacingToolName;
  input: unknown;
  latencyMs: number;
  authorization?: TraceAuthorization;
  outcome:
    | { kind: "returned"; value: unknown }
    | { kind: "threw"; error: unknown }
    /** invoker 已返回，但结果被 bridge 的序列化 / 大小上限拦截。 */
    | { kind: "egress-blocked"; value: unknown };
}

export interface ModelTraceSession {
  recordToolCall(call: TracedToolCall): void;
  /** bridge 在 invoker 之前拒绝（未暴露的工具）；工具名是模型选的字符串，不记录。 */
  recordRefusal(code: "POLICY_BLOCKED"): void;
}

export interface ModelTraceRecorder {
  /** 每个 MCP 连接一个 session：runId 共享，sessionId 与 seq 独立。 */
  session(): ModelTraceSession;
  /** 被 validateTraceEvent 拒绝或构造失败而丢弃的事件数。 */
  droppedCount(): number;
}

export interface TraceRecorderOptions {
  sink: TraceSink;
  /** 进程级 run id；文件 sink 用它命名 trace 文件，因此由组装层先生成。 */
  runId?: string;
  now?: () => number;
  uuid?: () => string;
}

type EventBody = Omit<
  RuntimeTraceEvent,
  "schemaVersion" | "ts" | "runId" | "sessionId" | "seq"
>;

const POLICY_CODES: ReadonlySet<string> = new Set([
  "POLICY_BLOCKED",
  "ORIGIN_NOT_ALLOWED",
  "AUTHORIZATION_REQUIRED",
  "MODEL_EGRESS_BLOCKED",
  "REF_NOT_IN_OBSERVATION",
]);
const PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "OBSERVATION_EXPIRED",
  "REF_NOT_FOUND",
  "REF_STALE",
  "DOCUMENT_CHANGED",
  "FRAME_CHANGED",
]);

const TOOL_EVENT: Readonly<Record<ModelFacingToolName, RuntimeTraceEventKind>> = {
  "browser.open": "action",
  "browser.observe": "observe",
  "browser.extract": "observe",
  "browser.verify": "verify",
  "browser.wait": "verify",
  "browser.act": "action",
};

/** 错误 code → 事件层；映射错误只影响归因，不影响任何执行结果。 */
export function traceEventForFailure(
  tool: ModelFacingToolName,
  code: string,
): RuntimeTraceEventKind {
  if (POLICY_CODES.has(code)) return "policy";
  if (PREFLIGHT_CODES.has(code) || code.startsWith("TARGET_")) {
    return "preflight";
  }
  return TOOL_EVENT[tool];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function coverage(value: unknown): RuntimeMetrics["candidateCoverage"] {
  return value === "complete" ||
    value === "truncated" ||
    value === "partial" ||
    value === "unknown"
    ? value
    : undefined;
}

function originOfUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const origin = new URL(value).origin;
    return isTraceOrigin(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

function verificationOutcome(value: unknown): TraceOutcome {
  const verification = record(value);
  if (verification?.verified === true) return "verified";
  if (verification?.conclusive === false) return "inconclusive";
  return "not-verified";
}

/**
 * 只保留通过格式检查的可选字段；不满足就省略该字段，事件照常记录。
 *
 * 调用方只能传入系统已证实的值（成功结果，或已被模型可见 store 查到的入参）；
 * 格式检查只是第二道防线（不变量 134）。
 */
function identifiers(fields: {
  tabId?: unknown;
  revision?: unknown;
  ref?: unknown;
  origin?: unknown;
}): Pick<EventBody, "tabId" | "revision" | "ref" | "origin"> {
  return {
    ...(isTraceTabId(fields.tabId) ? { tabId: fields.tabId } : {}),
    ...(isTraceRevision(fields.revision) ? { revision: fields.revision } : {}),
    ...(isTraceRef(fields.ref) ? { ref: fields.ref } : {}),
    ...(isTraceOrigin(fields.origin) ? { origin: fields.origin } : {}),
  };
}

type MetricInput = {
  [K in keyof RuntimeMetrics]?: RuntimeMetrics[K] | undefined;
};

function metrics(values: MetricInput): RuntimeMetrics {
  const result: RuntimeMetrics = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function successEvents(
  tool: ModelFacingToolName,
  input: Record<string, unknown> | undefined,
  value: unknown,
  latencyMs: number,
): EventBody[] {
  const result = record(value);
  const base = { source: "llm" as const, tool };

  switch (tool) {
    case "browser.open":
      return [{
        ...base,
        event: "action",
        outcome: "ok",
        // origin 取入参 url：它在调用 Runtime 之前已通过 navigation policy；
        // Runtime 回传的 requestedUrl 没有再经过 policy。
        ...identifiers({
          tabId: result?.tabId,
          origin: originOfUrl(input?.url),
        }),
        metrics: { latencyMs },
      }];
    case "browser.observe": {
      const tab = record(result?.tab);
      const actionable = record(record(result?.coverage)?.actionable);
      const elements = result?.elements;
      return [{
        ...base,
        event: "observe",
        outcome: "ok",
        ...identifiers({
          tabId: tab?.tabId,
          revision: record(result?.revision)?.id,
          origin: tab?.origin,
        }),
        metrics: metrics({
          latencyMs,
          candidateCount: Array.isArray(elements) ? elements.length : undefined,
          candidateTotalKnown: count(actionable?.totalKnown),
          candidateCoverage: coverage(actionable?.status),
        }),
      }];
    }
    // extract / verify / act 成功说明入参 (tabId, observedRevision) 已在本连接的
    // 模型可见 store 中查到（act 的 ref 也已在该 revision 的 elements 中查到）。
    case "browser.extract": {
      const items = result?.items;
      return [{
        ...base,
        event: "observe",
        outcome: "ok",
        ...identifiers({
          tabId: input?.tabId,
          revision: result?.revision,
        }),
        metrics: metrics({
          latencyMs,
          candidateCount: Array.isArray(items) ? items.length : undefined,
          candidateCoverage: coverage(result?.actionableCoverage),
        }),
      }];
    }
    case "browser.verify":
      return [{
        ...base,
        event: "verify",
        outcome: verificationOutcome(result),
        ...identifiers({
          tabId: input?.tabId,
          revision: input?.observedRevision,
        }),
        metrics: { latencyMs },
      }];
    case "browser.wait": {
      const observation = record(result?.observation);
      const verified = record(result?.verification)?.verified === true;
      return [{
        ...base,
        event: "verify",
        outcome: verified ? "verified" : "timed-out",
        ...identifiers({
          tabId: record(observation?.tab)?.tabId,
          revision: record(observation?.revision)?.id,
          origin: record(observation?.tab)?.origin,
        }),
        metrics: metrics({ latencyMs, attempts: count(result?.attempts) }),
      }];
    }
    case "browser.act":
      return [
        {
          ...base,
          event: "action",
          outcome: "executed",
          ...identifiers({
            tabId: input?.tabId,
            revision: input?.observedRevision,
            ref: input?.ref,
          }),
          metrics: { latencyMs },
        },
        {
          // 动作后验证的 revision 不会回到 bridge；动作前的 revision 不是它验证的对象。
          ...base,
          event: "verify",
          outcome: verificationOutcome(result?.verification),
          ...identifiers({ tabId: input?.tabId, ref: input?.ref }),
          metrics: metrics({ attempts: count(result?.verificationAttempts) }),
        },
      ];
  }
}

/**
 * 失败调用不记录任何来自入参的标识：此时 tabId / revision / ref 没有经过任何查表，
 * 是模型自己选的值，合法字符集同样能拼出任意数据（不变量 134）。
 */
function failureEvent(
  tool: ModelFacingToolName,
  code: TraceOutcome,
  latencyMs: number,
): EventBody {
  return {
    source: "llm",
    tool,
    event: traceEventForFailure(tool, code),
    outcome: code,
    metrics: { latencyMs },
  };
}

function boundedLatency(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function eventsFor(call: TracedToolCall): EventBody[] {
  const input = record(call.input);
  const latencyMs = boundedLatency(call.latencyMs);
  let events: EventBody[];

  switch (call.outcome.kind) {
    case "returned":
      events = successEvents(call.tool, input, call.outcome.value, latencyMs);
      break;
    case "threw": {
      const code: TraceOutcome =
        call.outcome.error instanceof BrowserRuntimeError
          ? call.outcome.error.code
          : "INTERNAL_ERROR";
      events = [failureEvent(call.tool, code, latencyMs)];
      break;
    }
    case "egress-blocked":
      events = [failureEvent(call.tool, "MODEL_EGRESS_BLOCKED", latencyMs)];
      break;
  }

  if (call.authorization !== undefined && events[0] !== undefined) {
    events[0] = { ...events[0], authorization: { ...call.authorization } };
  }
  return events;
}

/**
 * 进程级 trace recorder。
 *
 * trace 不是任何授权、执行或验证的前置条件（不变量 135）：构造、校验与 sink 中的
 * 任何异常都在这里吞掉，记录调用永远同步返回、永不抛出。
 */
export function createTraceRecorder(
  options: TraceRecorderOptions,
): ModelTraceRecorder {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const runId = options.runId ?? uuid();
  let dropped = 0;

  return {
    session() {
      const sessionId = uuid();
      let seq = 0;

      const emit = (body: EventBody): void => {
        seq += 1;
        const event: RuntimeTraceEvent = {
          schemaVersion: TRACE_SCHEMA_VERSION,
          ts: Math.floor(now()),
          runId,
          sessionId,
          seq,
          ...body,
        };
        if (!validateTraceEvent(event)) {
          dropped += 1;
          return;
        }
        options.sink.write(event);
      };

      return {
        recordToolCall(call) {
          try {
            for (const body of eventsFor(call)) emit(body);
          } catch {
            dropped += 1;
          }
        },
        recordRefusal(code) {
          try {
            emit({ source: "llm", event: "policy", outcome: code });
          } catch {
            dropped += 1;
          }
        },
      };
    },
    droppedCount() {
      return dropped;
    },
  };
}
