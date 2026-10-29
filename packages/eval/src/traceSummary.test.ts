import { describe, expect, it } from "vitest";
import type { RuntimeTraceEvent } from "@browser-agent-next/core";
import {
  parseTraceJsonl,
  summarizeTrace,
} from "./traceSummary.js";

const RUN = "0b6f9d2e-1c4a-4f7e-9a3b-5d8c2e1f0a4b";
const SESSION_A = "7a1e3c5b-9d2f-4e6a-8b0c-1f3d5e7a9c2b";
const SESSION_B = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function event(
  sessionId: string,
  seq: number,
  overrides: Partial<RuntimeTraceEvent> = {},
): RuntimeTraceEvent {
  return {
    schemaVersion: 1,
    ts: 1_761_700_000_000 + seq,
    runId: RUN,
    sessionId,
    seq,
    event: "observe",
    tool: "browser.observe",
    outcome: "ok",
    metrics: { latencyMs: seq * 10 },
    ...overrides,
  };
}

describe("parseTraceJsonl", () => {
  it("keeps schema-valid lines and counts everything else as invalid", () => {
    const text = [
      JSON.stringify(event(SESSION_A, 1)),
      "",
      "not json",
      JSON.stringify({ ...event(SESSION_A, 2), title: "page text" }),
      JSON.stringify(event(SESSION_A, 3)),
      "   ",
    ].join("\n");

    const parsed = parseTraceJsonl(text);
    expect(parsed.events.map((item) => item.seq)).toEqual([1, 3]);
    expect(parsed.invalidLines).toBe(2);
  });
});

describe("summarizeTrace", () => {
  it("counts events by layer and outcome, tool latency percentiles and approvals", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, index) => event(SESSION_A, index + 1)),
      event(SESSION_B, 1, {
        event: "action",
        tool: "browser.act",
        outcome: "executed",
        metrics: { latencyMs: 900 },
        authorization: { path: "operator", approval: "approved", waitMs: 800 },
      }),
      event(SESSION_B, 2, {
        event: "verify",
        tool: "browser.act",
        outcome: "verified",
        metrics: { attempts: 1 },
      }),
      event(SESSION_B, 3, {
        event: "policy",
        tool: "browser.act",
        outcome: "AUTHORIZATION_REQUIRED",
        metrics: { latencyMs: 60_000 },
        authorization: { path: "operator", approval: "timeout", waitMs: 60_000 },
      }),
      event(SESSION_B, 4, {
        event: "action",
        tool: "browser.act",
        outcome: "executed",
        metrics: { latencyMs: 300 },
        authorization: { path: "control-plane-auto", waitMs: 5 },
      }),
    ];

    const summary = summarizeTrace(events);

    expect(summary.eventCount).toBe(24);
    expect(summary.sessionCount).toBe(2);
    expect(summary.byEvent).toEqual({
      observe: { ok: 20 },
      action: { executed: 2 },
      verify: { verified: 1 },
      policy: { AUTHORIZATION_REQUIRED: 1 },
    });
    expect(summary.latencyByTool).toEqual({
      "browser.act": { count: 3, p50: 900, p95: 60_000 },
      "browser.observe": { count: 20, p50: 100, p95: 190 },
    });
    expect(summary.authorization).toEqual({ approved: 1, timeout: 1, auto: 1 });
    expect(summary.droppedBySeqGap).toBe(0);
  });

  it("infers dropped events from seq gaps per session", () => {
    const summary = summarizeTrace([
      event(SESSION_A, 1),
      event(SESSION_A, 4),
      event(SESSION_B, 2),
    ]);

    expect(summary.droppedBySeqGap).toBe(2 + 1);
  });

  it("handles an empty trace", () => {
    expect(summarizeTrace([])).toEqual({
      eventCount: 0,
      sessionCount: 0,
      byEvent: {},
      latencyByTool: {},
      authorization: {},
      droppedBySeqGap: 0,
    });
  });
});
