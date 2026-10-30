import {
  BrowserRuntimeError,
  type StrictActionArgs,
} from "@browser-agent-next/core";
import type {
  MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import type {
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  assertStrictActionTarget,
  type StrictClickAuthorizationInput,
  type StrictClickAuthorizationIssuanceService,
  type StrictClickAuthorizationResult,
} from "./authorizationIssuanceService.js";

export type OperatorApprovalState =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "invalidated"
  | "cancelled";

export interface OperatorApprovalRequestInput
  extends StrictClickAuthorizationInput {
  /**
   * 调用方愿意等待的时长；有效期取它与 store requestTtlMs 的较小值，
   * 不参与 grant 签发。
   */
  approvalTtlMs?: number;
}

export interface OperatorApprovalSummary {
  approvalRequestId: string;
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  origin: string;
  pageTitle: string;
  targetRole: string;
  targetName?: string;
  /** 批准后签发的正是这个动作；审批页据此显示“点击”或“填写”及完整值。 */
  action: StrictActionArgs;
  requestedAt: number;
  expiresAt: number;
  authorizationTtlMs: number;
}

export interface OperatorApprovalStatus {
  approvalRequestId: string;
  state: OperatorApprovalState | "unknown";
  authorizationId?: string;
  resolvedAt?: number;
  grantExpiresAt?: number;
}

export interface OperatorApprovalStoreOptions {
  now?: () => number;
  idFactory?: () => string;
  requestTtlMs?: number;
  maxPending?: number;
  maxOutcomes?: number;
}

interface PendingEntry
  extends OperatorApprovalSummary {
  input: StrictClickAuthorizationInput;
}

interface OutcomeEntry
  extends OperatorApprovalStatus {
  state: Exclude<
    OperatorApprovalState,
    "pending"
  >;
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
      name +
        " must be an integer between 1 and " +
        max,
    );
  }

  return value;
}

function defaultIdFactory(): string {
  if (
    typeof crypto.randomUUID === "function"
  ) {
    return (
      "operator-" + crypto.randomUUID()
    );
  }

  const bytes = crypto.getRandomValues(
    new Uint8Array(16),
  );

  return (
    "operator-" +
    Array.from(
      bytes,
      (byte) =>
        byte
          .toString(16)
          .padStart(2, "0"),
    ).join("")
  );
}

export class OperatorApprovalStore {
  private readonly now: () => number;
  private readonly idFactory:
    () => string;
  private readonly requestTtlMs: number;
  private readonly maxPending: number;
  private readonly maxOutcomes: number;
  private readonly pending =
    new Map<string, PendingEntry>();
  private readonly outcomes =
    new Map<string, OutcomeEntry>();
  private readonly listeners =
    new Set<(pendingCount: number) => void>();
  private lastNotifiedCount = 0;
  private notifyScheduled = false;

  constructor(
    private readonly states: TabStateStore,
    private readonly origins:
      MutableExactOriginAllowlist,
    private readonly issuance:
      StrictClickAuthorizationIssuanceService,
    options:
      OperatorApprovalStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ??
      defaultIdFactory;
    this.requestTtlMs =
      boundedPositiveInteger(
        options.requestTtlMs ?? 120_000,
        "requestTtlMs",
        5 * 60_000,
      );
    this.maxPending =
      boundedPositiveInteger(
        options.maxPending ?? 32,
        "maxPending",
        256,
      );
    this.maxOutcomes =
      boundedPositiveInteger(
        options.maxOutcomes ?? 64,
        "maxOutcomes",
        512,
      );
  }

  request(
    input: OperatorApprovalRequestInput,
  ): OperatorApprovalSummary {
    this.expirePending();

    if (
      !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.ttlMs > 60_000
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval authorization ttl is outside the allowed range",
      );
    }

    if (
      [...this.pending.values()].some(
        (entry) =>
          entry.authorizationId ===
          input.authorizationId,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "authorization id already has a pending operator approval",
      );
    }

    if (
      input.approvalTtlMs !== undefined &&
      (
        !Number.isInteger(input.approvalTtlMs) ||
        input.approvalTtlMs < 1
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval ttl must be a positive integer",
      );
    }

    const stored = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "operator approval requires a retained observation",
      );
    }

    const element =
      stored.byRef.get(input.ref);

    if (!element) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "operator approval target is outside the retained observation",
      );
    }

    const action: StrictActionArgs =
      input.action ?? { kind: "click" };
    // 入队前拒绝敏感 / 无效目标：审批页永远不显示凭据字段的待写入值（不变量 141）。
    assertStrictActionTarget(element, action);

    if (
      !this.origins.isAllowed(
        stored.observation.tab.origin,
      )
    ) {
      throw new BrowserRuntimeError(
        "ORIGIN_NOT_ALLOWED",
        "operator approval target origin is outside the auto-act allowlist",
      );
    }

    const approvalRequestId =
      this.uniqueId();
    const requestedAt = this.now();

    const summary:
      OperatorApprovalSummary = {
        approvalRequestId,
        authorizationId:
          input.authorizationId,
        tabId: input.tabId,
        observedRevision:
          input.observedRevision,
        ref: input.ref,
        origin:
          stored.observation.tab.origin,
        pageTitle:
          stored.observation.tab.title
            .slice(0, 500),
        targetRole:
          element.semantic.role
            .slice(0, 128),
        ...(element.semantic.name !==
        undefined
          ? {
              targetName:
                element.semantic.name
                  .slice(0, 500),
            }
          : {}),
        action,
        requestedAt,
        expiresAt:
          requestedAt +
          Math.min(
            input.approvalTtlMs ??
              this.requestTtlMs,
            this.requestTtlMs,
          ),
        authorizationTtlMs:
          input.ttlMs,
      };

    // approvalTtlMs 只决定等待时长，不进入签发输入。
    this.setPending(
      approvalRequestId,
      {
        ...summary,
        input: {
          authorizationId:
            input.authorizationId,
          tabId: input.tabId,
          observedRevision:
            input.observedRevision,
          ref: input.ref,
          ttlMs: input.ttlMs,
          action,
        },
      },
    );
    this.trimPending();

    return summary;
  }

  listPending():
    OperatorApprovalSummary[] {
    this.expirePending();

    return [
      ...this.pending.values(),
    ].map(
      ({
        input: _input,
        ...summary
      }) => summary,
    );
  }

  approve(
    approvalRequestId: string,
  ): {
    summary:
      OperatorApprovalSummary;
    grant:
      StrictClickAuthorizationResult;
  } {
    this.expirePending();

    const entry = this.pending.get(
      approvalRequestId,
    );

    if (!entry) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request is missing or no longer pending",
      );
    }

    this.deletePending(
      approvalRequestId,
    );

    const {
      input,
      ...summary
    } = entry;

    try {
      const grant =
        this.issuance
          .issueOperatorApproved(
            input,
          );

      this.recordOutcome({
        approvalRequestId,
        state: "approved",
        authorizationId:
          input.authorizationId,
        resolvedAt: this.now(),
        grantExpiresAt:
          grant.expiresAt,
      });

      return {
        summary,
        grant,
      };
    } catch (error) {
      this.recordOutcome({
        approvalRequestId,
        state: "invalidated",
        authorizationId:
          input.authorizationId,
        resolvedAt: this.now(),
      });
      throw error;
    }
  }

  reject(
    approvalRequestId: string,
  ): OperatorApprovalSummary {
    this.expirePending();

    const entry = this.pending.get(
      approvalRequestId,
    );

    if (!entry) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "operator approval request is missing or no longer pending",
      );
    }

    this.deletePending(
      approvalRequestId,
    );

    const {
      input,
      ...summary
    } = entry;

    this.recordOutcome({
      approvalRequestId,
      state: "rejected",
      authorizationId:
        input.authorizationId,
      resolvedAt: this.now(),
    });

    return summary;
  }

  status(
    approvalRequestId: string,
  ): OperatorApprovalStatus {
    this.expirePending();

    const pending =
      this.pending.get(
        approvalRequestId,
      );

    if (pending) {
      return {
        approvalRequestId,
        state: "pending",
        authorizationId:
          pending.authorizationId,
      };
    }

    return (
      this.outcomes.get(
        approvalRequestId,
      ) ?? {
        approvalRequestId,
        state: "unknown",
      }
    );
  }

  /**
   * 按 authorizationId 取消（全量扫描 pending 与 outcomes）。
   *
   * pending 一律记为 cancelled；approved 只有在 grant 确实被撤销
   * （grantRevoked=true，即尚未消费且未过期）时才翻转为 cancelled，
   * 已消费的 grant 代表点击可能已经发生，保留 approved。其他终态不变。
   * 同一 id 复用时，grant 已过期的历史 approved 不可能是被撤销的那一条，不翻转。
   */
  cancelByAuthorizationId(
    authorizationId: string,
    grantRevoked: boolean,
  ): void {
    this.expirePending();
    const now = this.now();

    for (
      const [id, entry]
      of this.pending
    ) {
      if (
        entry.authorizationId !==
        authorizationId
      ) {
        continue;
      }

      this.deletePending(id);

      this.recordOutcome({
        approvalRequestId: id,
        state: "cancelled",
        authorizationId,
        resolvedAt: now,
      });
    }

    if (!grantRevoked) {
      return;
    }

    for (
      const outcome
      of [...this.outcomes.values()]
    ) {
      if (
        outcome.authorizationId !==
          authorizationId ||
        outcome.state !== "approved" ||
        outcome.grantExpiresAt === undefined ||
        outcome.grantExpiresAt <= now
      ) {
        continue;
      }

      this.recordOutcome({
        approvalRequestId:
          outcome.approvalRequestId,
        state: "cancelled",
        authorizationId,
        resolvedAt: now,
      });
    }
  }

  clearTab(tabId: number): void {
    const now = this.now();

    for (
      const [id, entry]
      of this.pending
    ) {
      if (entry.tabId !== tabId) {
        continue;
      }

      this.deletePending(id);

      this.recordOutcome({
        approvalRequestId: id,
        state: "invalidated",
        authorizationId:
          entry.authorizationId,
        resolvedAt: now,
      });
    }
  }

  /**
   * 订阅 pending 数量变化（例如扩展角标）。
   *
   * 通知在当前同步操作结束后的 microtask 中发出：覆盖抛错路径，同一操作内的
   * 多次增删合并为一次，listener 也不会看到 store 的中间状态。数量不变不通知；
   * listener 抛错被吞掉，不影响 store。
   */
  subscribe(
    listener: (pendingCount: number) => void,
  ): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** pending 中最早的过期时间；没有 pending 时为 undefined。 */
  nextExpiryAt(): number | undefined {
    let earliest: number | undefined;

    for (const entry of this.pending.values()) {
      if (
        earliest === undefined ||
        entry.expiresAt < earliest
      ) {
        earliest = entry.expiresAt;
      }
    }

    return earliest;
  }

  private setPending(
    id: string,
    entry: PendingEntry,
  ): void {
    this.pending.set(id, entry);
    this.scheduleNotify();
  }

  private deletePending(id: string): void {
    if (this.pending.delete(id)) {
      this.scheduleNotify();
    }
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) {
      return;
    }

    this.notifyScheduled = true;

    queueMicrotask(() => {
      this.notifyScheduled = false;
      const count = this.pending.size;

      if (count === this.lastNotifiedCount) {
        return;
      }

      // 先前移再回调：listener 同步触发的二次变化会重新调度，而不是重入。
      this.lastNotifiedCount = count;

      for (const listener of [...this.listeners]) {
        try {
          listener(count);
        } catch {
          // 订阅方（角标）只是提示，不能影响审批状态。
        }
      }
    });
  }

  private uniqueId(): string {
    for (
      let attempt = 0;
      attempt < 4;
      attempt += 1
    ) {
      const id = this.idFactory();

      if (
        id.length > 0 &&
        id.length <= 256 &&
        !this.pending.has(id) &&
        !this.outcomes.has(id)
      ) {
        return id;
      }
    }

    throw new Error(
      "operator approval id factory failed to produce a unique bounded id",
    );
  }

  private expirePending(): void {
    const now = this.now();

    for (
      const [id, entry]
      of this.pending
    ) {
      if (
        entry.expiresAt > now
      ) {
        continue;
      }

      this.deletePending(id);

      this.recordOutcome({
        approvalRequestId: id,
        state: "expired",
        authorizationId:
          entry.authorizationId,
        resolvedAt: now,
      });
    }
  }

  private recordOutcome(
    outcome: OutcomeEntry,
  ): void {
    this.outcomes.delete(
      outcome.approvalRequestId,
    );
    this.outcomes.set(
      outcome.approvalRequestId,
      outcome,
    );

    while (
      this.outcomes.size >
      this.maxOutcomes
    ) {
      const oldest =
        this.outcomes
          .keys()
          .next()
          .value as
          | string
          | undefined;

      if (
        oldest === undefined
      ) {
        break;
      }

      this.outcomes.delete(
        oldest,
      );
    }
  }

  private trimPending(): void {
    while (
      this.pending.size >
      this.maxPending
    ) {
      const oldest =
        this.pending
          .keys()
          .next()
          .value as
          | string
          | undefined;

      if (
        oldest === undefined
      ) {
        break;
      }

      const entry =
        this.pending.get(oldest);

      this.deletePending(
        oldest,
      );

      if (entry) {
        this.recordOutcome({
          approvalRequestId:
            oldest,
          state: "invalidated",
          authorizationId:
            entry.authorizationId,
          resolvedAt:
            this.now(),
        });
      }
    }
  }
}
