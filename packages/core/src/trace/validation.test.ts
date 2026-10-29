import { describe, expect, it } from "vitest";
import type { RuntimeTraceEvent } from "./types.js";
import {
  isTraceOrigin,
  isTraceRef,
  isTraceRevision,
  validateTraceEvent,
} from "./validation.js";

const RUN_ID = "0b6f9d2e-1c4a-4f7e-9a3b-5d8c2e1f0a4b";
const SESSION_ID = "7a1e3c5b-9d2f-4e6a-8b0c-1f3d5e7a9c2b";

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: RuntimeTraceEvent = {
    schemaVersion: 1,
    ts: 1_761_700_000_000,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq: 1,
    event: "action",
    source: "llm",
    tool: "browser.act",
    tabId: 7,
    revision: "k3j9a8:g12:t7",
    ref: "@e_1A",
    origin: "https://a.test",
    outcome: "executed",
    metrics: {
      latencyMs: 42,
      candidateCount: 3,
      candidateTotalKnown: 3,
      candidateCoverage: "complete",
      attempts: 2,
    },
    authorization: { path: "operator", approval: "approved", waitMs: 1_200 },
  };
  return { ...base, ...overrides };
}

describe("validateTraceEvent", () => {
  it("accepts a fully populated event and a minimal one", () => {
    expect(validateTraceEvent(event())).toBe(true);
    expect(
      validateTraceEvent({
        schemaVersion: 1,
        ts: 0,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        seq: 1,
        event: "policy",
        outcome: "POLICY_BLOCKED",
      }),
    ).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(validateTraceEvent(event({ diagnostics: { title: "x" } }))).toBe(false);
    expect(validateTraceEvent(event({ metrics: { latencyMs: 1, name: "Save" } }))).toBe(false);
    expect(
      validateTraceEvent(event({ authorization: { path: "operator", authorizationId: "a" } })),
    ).toBe(false);
  });

  it("rejects malformed identifiers", () => {
    for (const overrides of [
      { runId: "not-a-uuid" },
      { sessionId: RUN_ID.toUpperCase() },
      { revision: "rev with space" },
      { revision: "r".repeat(129) },
      { ref: "@save" },
      { ref: "Delete account" },
      { tabId: -1 },
      { tabId: 1.5 },
      { tabId: 2 ** 31 },
      { seq: 0 },
      { ts: Number.NaN },
      { schemaVersion: 2 },
    ]) {
      expect(validateTraceEvent(event(overrides)), JSON.stringify(overrides)).toBe(false);
    }
  });

  it("rejects origins carrying anything beyond scheme, host and port", () => {
    for (const origin of [
      "https://a.test/page",
      "https://a.test/?q=secret",
      "https://a.test#frag",
      "https://user:pw@a.test",
      "null",
      "about:blank",
      "file:///etc/passwd",
      "https://" + "a".repeat(300) + ".test",
    ]) {
      expect(validateTraceEvent(event({ origin })), origin).toBe(false);
    }
  });

  it("rejects unknown enum members and non-numeric metrics", () => {
    for (const overrides of [
      { event: "click" },
      { source: "model" },
      { tool: "browser.eval" },
      { outcome: "Order placed" },
      { metrics: { latencyMs: -1 } },
      { metrics: { latencyMs: Number.POSITIVE_INFINITY } },
      { metrics: { candidateCount: "3" } },
      { metrics: { candidateCoverage: "full" } },
      { metrics: { confidence: 1.5 } },
      { metrics: { confidence: Number.NaN } },
      { authorization: { path: "auto" } },
      { authorization: { path: "operator", approval: "maybe" } },
      { authorization: { path: "operator", waitMs: -5 } },
    ]) {
      expect(validateTraceEvent(event(overrides)), JSON.stringify(overrides)).toBe(false);
    }
  });

  it("rejects non-object input", () => {
    for (const value of [null, undefined, "event", 1, [event()]]) {
      expect(validateTraceEvent(value)).toBe(false);
    }
  });
});

describe("trace field formats", () => {
  it("matches runtime ref and revision formats", () => {
    expect(isTraceRef("@e_1A")).toBe(true);
    expect(isTraceRef("@f_Z9")).toBe(true);
    expect(isTraceRevision("k3j9a8b7c6d5e4f3g2h1:g120:t42")).toBe(true);
  });

  it("accepts exact http(s) origins only", () => {
    expect(isTraceOrigin("https://a.test")).toBe(true);
    expect(isTraceOrigin("http://127.0.0.1:4173")).toBe(true);
    expect(isTraceOrigin("https://A.test")).toBe(false);
  });
});
