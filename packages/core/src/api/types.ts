import type { BrowserActionKind } from "../actions/types.js";
import type {
  BrowserObservation,
  RevisionId,
} from "../state/types.js";
import type {
  VerificationResult,
  VerificationSpec,
} from "../verification/types.js";

export type BrowserObserveProfile = "dom" | "hybrid";

export interface BrowserObserveOptions {
  profile?: BrowserObserveProfile;
  maxElements?: number;
  maxAxElements?: number;
  includeValues?: boolean;
  includeOpenShadowRoots?: boolean;
}

export interface BrowserObserveInput {
  tabId: number;
  sinceRevision?: RevisionId;
  options?: BrowserObserveOptions;
}

export interface BrowserVerifyInput {
  tabId: number;
  observedRevision: RevisionId;
  verification: VerificationSpec;
}

export interface BrowserWaitInput {
  tabId: number;
  verification: VerificationSpec;
  timeoutMs?: number;
  pollIntervalMs?: number;
  options?: BrowserObserveOptions;
}

export interface BrowserWaitResult {
  verification: VerificationResult;
  attempts: number;
  timedOut: boolean;
  observation?: BrowserObservation;
  lastObservationError?: string;
}

export interface BrowserActInput {
  tabId: number;
  action: {
    actionId: string;
    kind: BrowserActionKind;
    observedRevision: RevisionId;
    ref?: string;
    authorizationId?: string;
  };
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}
