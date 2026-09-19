import type { CoverageStatus, RevisionId } from "../state/types.js";

export type DecisionSource =
  | "recipe"
  | "webmcp"
  | "deterministic"
  | "jev"
  | "llm"
  | "vision"
  | "human";

export type RuntimeTraceEventKind =
  | "observe"
  | "candidate"
  | "decision"
  | "policy"
  | "preflight"
  | "action"
  | "effect"
  | "verify"
  | "escalate"
  | "finish";

export interface RuntimeMetrics {
  latencyMs?: number;
  candidateCount?: number;
  candidateTotalKnown?: number;
  candidateCoverage?: CoverageStatus;
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface RuntimeTraceEvent {
  ts: number;
  runId: string;
  sessionId: string;
  tabId?: number;
  revision?: RevisionId;
  event: RuntimeTraceEventKind;
  source?: DecisionSource;
  metrics?: RuntimeMetrics;
  outcome?: string;

  /**
   * Small, already-redacted diagnostic fields only.
   * Raw page text, screenshots, network bodies, credentials and form values
   * do not belong in the default trace contract.
   */
  diagnostics?: Record<string, string | number | boolean | null>;
}
