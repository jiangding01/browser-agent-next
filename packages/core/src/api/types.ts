import type { BrowserActionKind } from "../actions/types.js";
import type {
  BrowserObservation,
  CoverageStatus,
  ElementState,
  Ref,
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

export interface BrowserOpenInput {
  url: string;
  active?: boolean;
}

export interface BrowserOpenResult {
  tabId: number;

  /**
   * tabs.create 接受的规范化目标 URL。
   *
   * 这不是 committed/final URL 的证明；实际页面 URL 必须通过 browser.observe 获取。
   */
  requestedUrl: string;
  ownedBySession: true;
}

export interface BrowserObserveInput {
  tabId: number;
  sinceRevision?: RevisionId;
  options?: BrowserObserveOptions;
}

export interface BrowserExtractInput {
  tabId: number;
  observedRevision: RevisionId;
  refs?: Ref[];
  maxItems?: number;
}

export interface BrowserExtractResult {
  revision: RevisionId;
  items: ElementState[];
  missingRefs: Ref[];
  truncated: boolean;
  totalMatched: number;
  actionableCoverage: CoverageStatus;
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

  /**
   * 由 DOM mutation / navigation 等浏览器事件提前唤醒的次数。
   * 为 0 不表示没有变化，只表示本次 wait 没有依赖事件提前唤醒。
   */
  signalWakeups?: number;
}

export interface BrowserActInput {
  tabId: number;
  action: {
    actionId: string;
    kind: BrowserActionKind;
    observedRevision: RevisionId;
    ref?: string;
    authorizationId?: string;
    /** 仅 kind === "setValue"：要写入的单行值。 */
    value?: string;
  };
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}
