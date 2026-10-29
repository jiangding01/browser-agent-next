import {
  validateTraceEvent,
  type RuntimeTraceEvent,
} from "@browser-agent-next/core";

export interface ParsedTrace {
  events: RuntimeTraceEvent[];
  /** 非 JSON 或未通过 validateTraceEvent 的行数；这些行不进入汇总。 */
  invalidLines: number;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
}

export interface TraceSummary {
  eventCount: number;
  sessionCount: number;
  /** event → outcome → 次数：分层归因的原始计数（docs/EVAL.md「Failure attribution」）。 */
  byEvent: Record<string, Record<string, number>>;
  /** 每个 tool 的调用延迟（只取带 latencyMs 的事件），nearest-rank 百分位。 */
  latencyByTool: Record<string, LatencySummary>;
  /** act 授权阶段的最终审批状态分布；control-plane-auto 路径计为 "auto"。 */
  authorization: Record<string, number>;
  /**
   * 由 seq 断档推出的丢弃事件数。
   *
   * 只能看到“之后还有记录”的丢弃：文件写满或写入失败后 session 尾部的丢弃
   * 不形成断档（sink 会在 stderr 提示），因此这是下限而不是总数。
   */
  droppedBySeqGap: number;
}

export function parseTraceJsonl(text: string): ParsedTrace {
  const events: RuntimeTraceEvent[] = [];
  let invalidLines = 0;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (validateTraceEvent(value)) {
        events.push(value);
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }

  return { events, invalidLines };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function summarizeTrace(
  events: readonly RuntimeTraceEvent[],
): TraceSummary {
  const byEvent: Record<string, Record<string, number>> = {};
  const latencies = new Map<string, number[]>();
  const authorization: Record<string, number> = {};
  const sessions = new Map<string, { count: number; maxSeq: number }>();

  for (const event of events) {
    increment((byEvent[event.event] ??= {}), event.outcome);

    const latency = event.metrics?.latencyMs;
    if (event.tool !== undefined && latency !== undefined) {
      const list = latencies.get(event.tool) ?? [];
      list.push(latency);
      latencies.set(event.tool, list);
    }

    if (event.authorization !== undefined) {
      increment(
        authorization,
        event.authorization.path === "control-plane-auto"
          ? "auto"
          : (event.authorization.approval ?? "none"),
      );
    }

    const key = event.runId + "/" + event.sessionId;
    const session = sessions.get(key) ?? { count: 0, maxSeq: 0 };
    session.count += 1;
    session.maxSeq = Math.max(session.maxSeq, event.seq);
    sessions.set(key, session);
  }

  const latencyByTool: Record<string, LatencySummary> = {};
  for (const [tool, list] of [...latencies].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort((a, b) => a - b);
    latencyByTool[tool] = {
      count: sorted.length,
      p50: nearestRank(sorted, 50),
      p95: nearestRank(sorted, 95),
    };
  }

  let droppedBySeqGap = 0;
  for (const session of sessions.values()) {
    droppedBySeqGap += Math.max(0, session.maxSeq - session.count);
  }

  return {
    eventCount: events.length,
    sessionCount: sessions.size,
    byEvent,
    latencyByTool,
    authorization,
    droppedBySeqGap,
  };
}
