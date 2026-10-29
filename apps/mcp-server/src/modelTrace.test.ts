import { describe, expect, it } from "vitest";
import {
  BrowserRuntimeError,
  TRACE_TOOL_NAMES,
  validateTraceEvent,
  type RuntimeTraceEvent,
} from "@browser-agent-next/core";
import { MODEL_FACING_TOOL_NAMES } from "@browser-agent-next/policy";
import {
  createTraceRecorder,
  traceEventForFailure,
  type TracedToolCall,
} from "./modelTrace.js";
import { makeObservation } from "./testing/fakeTrustedRuntime.js";

const SECRET = "CANARY-7b-unit";

function harness(sinkWrite?: (event: RuntimeTraceEvent) => void) {
  const events: RuntimeTraceEvent[] = [];
  let ids = 0;
  const recorder = createTraceRecorder({
    sink: {
      write: sinkWrite ?? ((event) => {
        events.push(event);
      }),
    },
    now: () => 1_761_700_000_000,
    uuid: () => {
      ids += 1;
      return "00000000-0000-4000-8000-" + String(ids).padStart(12, "0");
    },
  });
  return { recorder, events, session: recorder.session() };
}

function call(overrides: Partial<TracedToolCall> & Pick<TracedToolCall, "tool" | "outcome">): TracedToolCall {
  return { input: {}, latencyMs: 12, ...overrides };
}

const observation = makeObservation({
  tabId: 3,
  revision: "rt9x:g4:t3",
  url: "https://a.test/orders/1024?token=" + SECRET,
  title: "Orders " + SECRET,
  elements: [],
});

describe("trace tool names", () => {
  it("match the model-facing tool catalog", () => {
    expect([...TRACE_TOOL_NAMES].sort()).toEqual([...MODEL_FACING_TOOL_NAMES].sort());
  });
});

describe("traceEventForFailure", () => {
  it("attributes codes to the policy, preflight or tool layer", () => {
    expect(traceEventForFailure("browser.act", "AUTHORIZATION_REQUIRED")).toBe("policy");
    expect(traceEventForFailure("browser.observe", "MODEL_EGRESS_BLOCKED")).toBe("policy");
    expect(traceEventForFailure("browser.act", "TARGET_OCCLUDED")).toBe("preflight");
    expect(traceEventForFailure("browser.act", "DOCUMENT_CHANGED")).toBe("preflight");
    expect(traceEventForFailure("browser.act", "ACTION_OUTCOME_UNKNOWN")).toBe("action");
    expect(traceEventForFailure("browser.observe", "STATE_INCOMPLETE")).toBe("observe");
    expect(traceEventForFailure("browser.wait", "INTERNAL_ERROR")).toBe("verify");
  });
});

describe("createTraceRecorder", () => {
  it("records observe with counts, revision and origin but no page text", () => {
    const { session, events } = harness();
    session.recordToolCall(call({
      tool: "browser.observe",
      input: { tabId: 3 },
      outcome: {
        kind: "returned",
        value: {
          ...observation,
          elements: [{ ref: "@e_1", semantic: { name: SECRET } }, { ref: "@e_2" }],
          coverage: {
            ...observation.coverage,
            actionable: { status: "truncated", returned: 2, totalKnown: 9 },
          },
        },
      },
    }));

    expect(events).toEqual([{
      schemaVersion: 1,
      ts: 1_761_700_000_000,
      runId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      seq: 1,
      source: "llm",
      tool: "browser.observe",
      event: "observe",
      outcome: "ok",
      tabId: 3,
      revision: "rt9x:g4:t3",
      origin: "https://a.test",
      metrics: {
        latencyMs: 12,
        candidateCount: 2,
        candidateTotalKnown: 9,
        candidateCoverage: "truncated",
      },
    }]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("records only the origin of the policy-checked input URL, never the runtime echo", () => {
    const { session, events } = harness();
    session.recordToolCall(call({
      tool: "browser.open",
      input: { url: "https://a.test/p?q=" + SECRET },
      outcome: {
        kind: "returned",
        value: { tabId: 5, requestedUrl: "https://other.test/p?q=" + SECRET, ownedBySession: true },
      },
    }));

    expect(events[0]).toMatchObject({ event: "action", tabId: 5, origin: "https://a.test", outcome: "ok" });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("maps verify and wait outcomes", () => {
    const { session, events } = harness();
    for (const value of [
      { verified: true, conclusive: true, evidence: [] },
      { verified: false, conclusive: true, evidence: [] },
      { verified: false, conclusive: false, evidence: [] },
    ]) {
      session.recordToolCall(call({
        tool: "browser.verify",
        input: { tabId: 3, observedRevision: "rt9x:g4:t3", verification: { text: SECRET } },
        outcome: { kind: "returned", value },
      }));
    }
    session.recordToolCall(call({
      tool: "browser.wait",
      input: { tabId: 99 },
      outcome: {
        kind: "returned",
        value: { verification: { verified: false }, attempts: 7, timedOut: true, observation },
      },
    }));

    expect(events.map((item) => item.outcome)).toEqual([
      "verified",
      "not-verified",
      "inconclusive",
      "timed-out",
    ]);
    expect(events[3]).toMatchObject({
      event: "verify",
      tabId: 3,
      revision: "rt9x:g4:t3",
      origin: "https://a.test",
      metrics: { latencyMs: 12, attempts: 7 },
    });
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it("records an executed act as an action plus a post-action verify carrying authorization", () => {
    const { session, events } = harness();
    session.recordToolCall(call({
      tool: "browser.act",
      input: { tabId: 3, observedRevision: "rt9x:g4:t3", ref: "@e_1A" },
      authorization: { path: "operator", approval: "approved", waitMs: 1_000 },
      outcome: {
        kind: "returned",
        value: {
          status: "executed",
          effectClass: "unknown",
          verification: { verified: true, conclusive: true, evidence: [] },
          verificationAttempts: 2,
        },
      },
    }));

    expect(events).toMatchObject([
      {
        event: "action",
        outcome: "executed",
        ref: "@e_1A",
        authorization: { path: "operator", approval: "approved", waitMs: 1_000 },
      },
      { event: "verify", outcome: "verified", ref: "@e_1A", metrics: { attempts: 2 } },
    ]);
    expect(events[0]).toMatchObject({ tabId: 3, revision: "rt9x:g4:t3" });
    expect(events[1]).not.toHaveProperty("authorization");
    expect(events[1]).not.toHaveProperty("revision");
  });

  it("records failures by code and layer", () => {
    const { session, events } = harness();
    session.recordToolCall(call({
      tool: "browser.act",
      input: { tabId: 3, observedRevision: "rt9x:g4:t3", ref: "@e_1A" },
      authorization: { path: "operator", approval: "rejected", waitMs: 2_000 },
      outcome: {
        kind: "threw",
        error: new BrowserRuntimeError("AUTHORIZATION_REQUIRED", "operator rejected " + SECRET),
      },
    }));
    session.recordToolCall(call({
      tool: "browser.observe",
      input: { tabId: 3 },
      outcome: { kind: "threw", error: new Error(SECRET) },
    }));
    session.recordToolCall(call({
      tool: "browser.observe",
      input: { tabId: 3 },
      outcome: { kind: "egress-blocked", value: observation },
    }));

    expect(events).toMatchObject([
      {
        event: "policy",
        outcome: "AUTHORIZATION_REQUIRED",
        authorization: { approval: "rejected" },
      },
      { event: "observe", outcome: "INTERNAL_ERROR" },
      { event: "policy", outcome: "MODEL_EGRESS_BLOCKED", tool: "browser.observe" },
    ]);
    for (const failure of events) {
      expect(failure).not.toHaveProperty("tabId");
      expect(failure).not.toHaveProperty("revision");
      expect(failure).not.toHaveProperty("ref");
      expect(failure).not.toHaveProperty("origin");
    }
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("never records unverified model input, even when it matches the runtime formats", () => {
    const { session, events } = harness();
    // 合法字符集同样能拼出敏感数据：失败调用的入参从未被查表，一律不记录。
    session.recordToolCall(call({
      tool: "browser.act",
      input: { tabId: 1_234_567, observedRevision: "ssn:123-45-6789_pw.hunter2", ref: "@secret_HUNTER2" },
      outcome: {
        kind: "threw",
        error: new BrowserRuntimeError("MODEL_EGRESS_BLOCKED", "x"),
      },
    }));
    session.recordToolCall(call({
      tool: "browser.observe",
      input: { tabId: 3 },
      outcome: {
        kind: "returned",
        value: { ...observation, tab: { ...observation.tab, origin: "null" } },
      },
    }));

    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty("tabId");
    expect(events[0]).not.toHaveProperty("revision");
    expect(events[0]).not.toHaveProperty("ref");
    expect(events[1]).not.toHaveProperty("origin");
    expect(events[1]).toMatchObject({ tabId: 3, revision: "rt9x:g4:t3" });
    expect(events.map((item) => item.seq)).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toMatch(/hunter2|HUNTER2|1234567/);
  });

  it("records refusals without the model-chosen tool name", () => {
    const { session, events } = harness();
    session.recordRefusal("POLICY_BLOCKED");

    expect(events).toEqual([expect.objectContaining({ event: "policy", outcome: "POLICY_BLOCKED" })]);
    expect(events[0]).not.toHaveProperty("tool");
  });

  it("gives each session its own id and sequence under one run id", () => {
    const { recorder, events, session } = harness();
    const other = recorder.session();
    session.recordRefusal("POLICY_BLOCKED");
    other.recordRefusal("POLICY_BLOCKED");
    session.recordRefusal("POLICY_BLOCKED");

    expect(new Set(events.map((item) => item.runId)).size).toBe(1);
    expect(events.map((item) => [item.sessionId.slice(-1), item.seq])).toEqual([
      ["2", 1],
      ["3", 1],
      ["2", 2],
    ]);
    expect(events.every((item) => validateTraceEvent(item))).toBe(true);
  });

  it("never throws when the sink throws", () => {
    let writes = 0;
    const { session } = harness(() => {
      writes += 1;
      throw new Error("disk on fire");
    });

    expect(() => session.recordRefusal("POLICY_BLOCKED")).not.toThrow();
    expect(() =>
      session.recordToolCall(call({ tool: "browser.observe", outcome: { kind: "returned", value: observation } })),
    ).not.toThrow();
    expect(writes).toBe(2);
  });

  it("drops schema-invalid events silently, leaving them out of the sink", () => {
    const events: RuntimeTraceEvent[] = [];
    const recorder = createTraceRecorder({
      sink: { write: (event) => events.push(event) },
      uuid: () => "not-a-uuid",
    });

    expect(() => recorder.session().recordRefusal("POLICY_BLOCKED")).not.toThrow();
    expect(events).toEqual([]);
  });

  it("records an executed act whose result was blocked by the result bound as both executed and blocked", () => {
    const { session, events } = harness();
    session.recordToolCall(call({
      tool: "browser.act",
      input: { tabId: 3, observedRevision: "rt9x:g4:t3", ref: "@e_1A" },
      authorization: { path: "control-plane-auto", waitMs: 1 },
      outcome: {
        kind: "egress-blocked",
        value: {
          status: "executed",
          effectClass: "unknown",
          verification: { verified: true, conclusive: true, evidence: [] },
          verificationAttempts: 1,
        },
      },
    }));

    expect(events.map((item) => [item.event, item.outcome])).toEqual([
      ["action", "executed"],
      ["verify", "verified"],
      ["policy", "MODEL_EGRESS_BLOCKED"],
    ]);
    expect(events[0]).toMatchObject({ authorization: { path: "control-plane-auto" } });
    expect(events[2]).not.toHaveProperty("metrics");
  });
});
