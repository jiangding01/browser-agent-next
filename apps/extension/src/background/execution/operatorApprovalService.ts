import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import type {
  TabStateStore,
} from "@browser-agent-next/runtime";
import type {
  AuthorizationIssuanceService,
  IssuedStrictClickAuthorization,
  StrictClickAuthorizationInput,
} from "./authorizationIssuanceService.js";

export type OperatorApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export interface OperatorApprovalTargetSummary {
  ref: string;
  role: string;
  name?: string;
  description?: string;
}

export interface OperatorApprovalView {
  approvalRequestId: string;
  status: OperatorApprovalStatus;
  createdAt: number;
  expiresAt: number;
  tab: {
    tabId: number;
    title: string;
    url: string;
    origin: string;
    ownedBySession: boolean;
  };
  target: OperatorApprovalTargetSummary;
}

export interface OperatorApprovalStatusResult {
  approvalRequestId: string;
  status: OperatorApprovalStatus;
  expiresAt: number;
  authorizationId: string;
  grant?: IssuedStrictClickAuthorization;
}

export interface OperatorApprovalServiceOptions {
  now?: () => number;
  requestId?: () => string;
  approvalTtlMs?: number;
  resultRetentionMs?: number;
  maxEntries?: number;
}

interface OperatorApprovalEntry {
  request: StrictClickAuthorizationInput;
  view: OperatorApprovalView;
  status: OperatorApprovalStatus;
  resultExpiresAt?: number;
  grant?: IssuedStrictClickAuthorization;
}

function boundedPositiveInteger(
  value: number,
  name: string,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(
      name + " must be an integer between 1 and " + max,
    );
  }
  return value;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

function defaultRequestId(): string {
  return "approval-" + crypto.randomUUID();
}

/**
 * operator-approved 的 pending approval 状态机。
 *
 * 这个 service 不监听普通 runtime.onMessage，也不接受 assurance/source 参数。
 * 真正的 UI ingress 下一层只允许调用 approve()/deny()；approve() 内部固定走
 * issueOperatorApprovedStrictClick()。
 */
export class OperatorApprovalService {
  private readonly now: () => number;
  private readonly requestId: () => string;
  private readonly approvalTtlMs: number;
  private readonly resultRetentionMs: number;
  private readonly maxEntries: number;
  private readonly entries =
    new Map<string, OperatorApprovalEntry>();

  constructor(
    private readonly states: TabStateStore,
    private readonly issuance: AuthorizationIssuanceService,
    options: OperatorApprovalServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.requestId =
      options.requestId ?? defaultRequestId;
    this.approvalTtlMs =
      boundedPositiveInteger(
        options.approvalTtlMs ?? 60_000,
        "approvalTtlMs",
        5 * 60_000,
      );
    this.resultRetentionMs =
      boundedPositiveInteger(
        options.resultRetentionMs ?? 60_000,
        "resultRetentionMs",
        5 * 60_000,
      );
    this.maxEntries =
      boundedPositiveInteger(
        options.maxEntries ?? 32,
        "maxEntries",
        256,
      );
  }

  requestStrictClickApproval(
    request: StrictClickAuthorizationInput,
  ): OperatorApprovalView {
    this.cleanup();

    if (
      !validId(request.authorizationId) ||
      !Number.isInteger(request.tabId) ||
      request.tabId < 0 ||
      !validId(request.observedRevision) ||
      !validId(request.ref) ||
      !Number.isFinite(request.ttlMs) ||
      request.ttlMs <= 0 ||
      request.ttlMs > 60_000
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request is invalid or unbounded",
      );
    }

    for (const entry of this.entries.values()) {
      if (
        entry.status === "pending" &&
        entry.request.authorizationId ===
          request.authorizationId
      ) {
        throw new BrowserRuntimeError(
          "AUTHORIZATION_REQUIRED",
          "an operator approval is already pending for this authorization id",
        );
      }
    }

    if (this.entries.size >= this.maxEntries) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "too many operator approval requests are pending or retained",
      );
    }

    const stored = this.states.get(
      request.tabId,
      request.observedRevision,
    );
    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "cannot request operator approval for an observation that is no longer retained",
      );
    }

    const target = stored.byRef.get(request.ref);
    if (!target) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "cannot request operator approval for a ref outside the retained observation",
      );
    }

    const approvalRequestId = this.requestId();
    if (!validId(approvalRequestId)) {
      throw new Error(
        "operator approval request id generator returned an invalid id",
      );
    }
    if (this.entries.has(approvalRequestId)) {
      throw new Error(
        "operator approval request id collision",
      );
    }

    const createdAt = this.now();
    const expiresAt =
      createdAt + this.approvalTtlMs;
    const view: OperatorApprovalView = {
      approvalRequestId,
      status: "pending",
      createdAt,
      expiresAt,
      tab: {
        tabId: stored.observation.tab.tabId,
        title: stored.observation.tab.title,
        url: stored.observation.tab.url,
        origin: stored.observation.tab.origin,
        ownedBySession:
          stored.observation.tab.ownedBySession,
      },
      target: {
        ref: target.ref,
        role: target.semantic.role,
        ...(target.semantic.name !== undefined
          ? { name: target.semantic.name }
          : {}),
        ...(target.semantic.description !== undefined
          ? {
              description:
                target.semantic.description,
            }
          : {}),
      },
    };

    this.entries.set(approvalRequestId, {
      request: { ...request },
      view,
      status: "pending",
    });

    return view;
  }

  getForUi(
    approvalRequestId: string,
  ): OperatorApprovalView {
    const entry =
      this.requireEntry(approvalRequestId);
    return {
      ...entry.view,
      status: entry.status,
    };
  }

  getStatus(
    approvalRequestId: string,
  ): OperatorApprovalStatusResult {
    const entry =
      this.requireEntry(approvalRequestId);
    return {
      approvalRequestId,
      status: entry.status,
      expiresAt:
        entry.resultExpiresAt ??
        entry.view.expiresAt,
      authorizationId:
        entry.request.authorizationId,
      ...(entry.grant !== undefined
        ? { grant: entry.grant }
        : {}),
    };
  }

  approve(
    approvalRequestId: string,
  ): OperatorApprovalStatusResult {
    const entry =
      this.requirePending(approvalRequestId);

    const grant =
      this.issuance
        .issueOperatorApprovedStrictClick(
          entry.request,
        );

    const now = this.now();
    entry.status = "approved";
    entry.grant = grant;
    entry.resultExpiresAt =
      now + this.resultRetentionMs;

    return this.getStatus(
      approvalRequestId,
    );
  }

  deny(
    approvalRequestId: string,
  ): OperatorApprovalStatusResult {
    const entry =
      this.requirePending(approvalRequestId);

    entry.status = "denied";
    entry.resultExpiresAt =
      this.now() + this.resultRetentionMs;

    return this.getStatus(
      approvalRequestId,
    );
  }

  clearTab(tabId: number): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (
        entry.request.tabId === tabId &&
        entry.status === "pending"
      ) {
        entry.status = "cancelled";
        entry.resultExpiresAt =
          now + this.resultRetentionMs;
      }
    }
  }

  size(): number {
    this.cleanup();
    return this.entries.size;
  }

  private requireEntry(
    approvalRequestId: string,
  ): OperatorApprovalEntry {
    if (!validId(approvalRequestId)) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request id is invalid",
      );
    }

    this.cleanup();
    const entry =
      this.entries.get(approvalRequestId);
    if (!entry) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request is missing or no longer retained",
      );
    }
    return entry;
  }

  private requirePending(
    approvalRequestId: string,
  ): OperatorApprovalEntry {
    const entry =
      this.requireEntry(approvalRequestId);
    if (entry.status !== "pending") {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request is not pending: " +
          entry.status,
      );
    }
    return entry;
  }

  private cleanup(): void {
    const now = this.now();

    for (const [id, entry] of this.entries) {
      if (
        entry.status === "pending" &&
        entry.view.expiresAt <= now
      ) {
        entry.status = "expired";
        entry.resultExpiresAt =
          now + this.resultRetentionMs;
      }

      if (
        entry.status !== "pending" &&
        entry.resultExpiresAt !== undefined &&
        entry.resultExpiresAt <= now
      ) {
        this.entries.delete(id);
      }
    }
  }
}
