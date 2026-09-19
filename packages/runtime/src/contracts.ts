import type {
  ActionResult,
  BrowserAction,
  BrowserObservation,
  VerificationResult,
  VerificationSpec,
} from "@browser-agent-next/core";

export interface ObserveRequest {
  tabId: number;
  view: "summary" | "interactive" | "form" | "read";
  sinceRevision?: string;
  full?: boolean;
  scope?: { ref?: string; region?: string };
}

export interface BrowserRuntime {
  observe(request: ObserveRequest): Promise<BrowserObservation>;
  act(action: BrowserAction): Promise<ActionResult>;
  verify(tabId: number, spec: VerificationSpec): Promise<VerificationResult>;
}

export interface DecisionProvider<TState, TDecision> {
  readonly id: string;
  decide(input: { state: TState; signal: AbortSignal }): Promise<{
    decision: TDecision;
    model?: string;
    latencyMs: number;
    confidence?: number;
    rawUsage?: unknown;
  }>;
}
