import {
  BrowserRuntimeError,
  type BrowserAction,
  type EffectAssessment,
} from "@browser-agent-next/core";
import {
  evaluateEffectPolicy,
  minimumAuthorizationAssurance,
  type InMemoryAuthorizationStore,
} from "@browser-agent-next/policy";
import type {
  StoredObservationStrictCoordinator,
} from "@browser-agent-next/runtime";
import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";
import {
  StrictClickDispatchError,
  type ChromeStrictClickDispatcher,
} from "./chromeStrictClickDispatcher.js";
import type { StrictClickPresentationFence } from "./rootPresentationFence.js";

export interface StrictClickOriginPolicy {
  isAllowed(origin: string): boolean;
}

export interface ExecuteStrictClickInput {
  tabId: number;
  actionId: string;
  observedRevision: string;
  ref: string;

  /**
   * 只能引用 trusted UI / control-plane host 已经签发的 grant。
   * 没有 grant 时，unknown-effect click 不会执行。
   *
   * trusted-host token 证明来自控制平面，但不自动等价于人工批准。
   * 如果同一 Agent 拥有读取 token 的本地 OS 权限，该 token 不能作为
   * 对该 Agent 的强隔离边界。详见 docs/SECURITY.md。
   */
  authorizationId?: string;
}

export interface ExecuteStrictClickResult {
  actionId: string;
  status: "executed";
  observedRevision: string;
  ref: string;
  effect: EffectAssessment;
}

// 同一份 live layout 重新计算的 projection 应逐位一致；只容忍浮点噪声。
const PRESENTED_POINT_TOLERANCE_PX = 0.01;

/**
 * fence 前后的两次 prepare 必须指向同一个 live 目标与同一个 top-level 点；
 * 否则 fence 期间 layout 发生了变化，已 present 的 hit-test 数据不能证明
 * 新点的路由结果。
 */
function samePresentedTarget(
  before: PreparedStrictClickTarget,
  after: PreparedStrictClickTarget,
): boolean {
  return (
    before.tabId === after.tabId &&
    before.ref === after.ref &&
    before.stableId === after.stableId &&
    before.backendNodeId === after.backendNodeId &&
    before.cdpFrameId === after.cdpFrameId &&
    before.cdpSessionId === after.cdpSessionId &&
    before.frameEpoch === after.frameEpoch &&
    before.coordinateSpace === after.coordinateSpace &&
    Math.abs(before.point.x - after.point.x) <=
      PRESENTED_POINT_TOLERANCE_PX &&
    Math.abs(before.point.y - after.point.y) <=
      PRESENTED_POINT_TOLERANCE_PX
  );
}

/**
 * 任意 click 的业务副作用默认无法从页面结构证明，因此第一版统一为 unknown。
 * 后续 Effect Classifier 可以提升结构化 action 的精度，但不能把模型猜测当 known。
 */
function conservativeClickEffect(): EffectAssessment {
  return {
    class: "unknown",
    confidence: "unknown",
    evidence: [
      "generic click effect cannot be proven from DOM/AX semantics alone",
    ],
  };
}

export class PolicyGatedStrictClickExecutor {
  constructor(
    private readonly coordinator:
      StoredObservationStrictCoordinator<PreparedStrictClickTarget>,
    private readonly dispatcher: ChromeStrictClickDispatcher,
    private readonly authorizations: InMemoryAuthorizationStore,
    private readonly origins: StrictClickOriginPolicy,
    private readonly presentationFence: StrictClickPresentationFence,
  ) {}

  async execute(
    input: ExecuteStrictClickInput,
  ): Promise<ExecuteStrictClickResult> {
    const action: BrowserAction = {
      actionId: input.actionId,
      kind: "click",
      observedRevision: input.observedRevision,
      target: { ref: input.ref },
      ...(input.authorizationId
        ? { authorization: { id: input.authorizationId } }
        : {}),
    };

    const preparedBeforePolicy = await this.coordinator.prepare(
      input.tabId,
      action,
    );

    const effect = conservativeClickEffect();

    const requiredAssurance =
      minimumAuthorizationAssurance(
        effect.class,
        preparedBeforePolicy.observation.tab.ownedBySession,
      );

    const auth = input.authorizationId
      ? this.authorizations.consume({
          id: input.authorizationId,
          tabId: input.tabId,
          observedRevision: input.observedRevision,
          ref: input.ref,
          actionKind: "click",
          effectClass: effect.class,
          ...(requiredAssurance !== undefined
            ? { minimumAssurance: requiredAssurance }
            : {}),
        })
      : undefined;

    const decision = evaluateEffectPolicy({
      effect,
      tabOwnedBySession:
        preparedBeforePolicy.observation.tab.ownedBySession,
      originAllowed: this.origins.isAllowed(
        preparedBeforePolicy.observation.tab.origin,
      ),
      ...(auth?.ok === true
        ? { authorizationAssurance: auth.grant.assurance }
        : {}),
    });

    if (decision.verdict !== "allow") {
      throw new BrowserRuntimeError(
        decision.verdict === "deny"
          ? "POLICY_BLOCKED"
          : "AUTHORIZATION_REQUIRED",
        "strict click blocked by effect policy: " +
          decision.reasons.join("; "),
        {
          effect,
          verdict: decision.verdict,
          requiredAssurance: decision.requiredAssurance,
          authorizationReason:
            auth && !auth.ok ? auth.reason : undefined,
        },
      );
    }

    // commit 前再次读取 live identity/actionability，绝不复用第一次 point。
    const preparedForCommit = await this.coordinator.prepare(
      input.tabId,
      action,
    );

    let commitTarget = preparedForCommit.prepared;

    if (this.presentationFence.required(commitTarget)) {
      // 浏览器按 root renderer 已 present 的 hit-test 数据跨 process 路由输入；
      // 必须先证明 prepare 读到的 layout 已经被 present，再在 fence 之后
      // 重新 prepare，确认 identity 与 top-level 点都没有变化。
      const fenced =
        await this.presentationFence.waitForPresentedFrames(
          input.tabId,
        );

      if (!fenced.ok) {
        throw new BrowserRuntimeError(
          "TARGET_NOT_VISIBLE",
          "strict click input routing cannot be proven before dispatch: " +
            fenced.reason,
          {
            ref: input.ref,
            actionId: input.actionId,
          },
        );
      }

      const confirmed = await this.coordinator.prepare(
        input.tabId,
        action,
      );

      if (
        !samePresentedTarget(
          commitTarget,
          confirmed.prepared,
        )
      ) {
        throw new BrowserRuntimeError(
          "TARGET_IDENTITY_MISMATCH",
          "strict click target geometry changed while waiting for browser presentation",
          {
            ref: input.ref,
            actionId: input.actionId,
          },
        );
      }

      commitTarget = confirmed.prepared;
    }

    if (
      auth?.ok === true &&
      auth.grant.expiresAt <= Date.now()
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "strict click authorization expired before dispatch",
        {
          effect,
          requiredAssurance,
          authorizationReason: "expired",
        },
      );
    }

    try {
      await this.dispatcher.dispatch(
        commitTarget,
      );
    } catch (error) {
      if (
        error instanceof StrictClickDispatchError &&
        error.outcomeMayHaveChanged
      ) {
        throw new BrowserRuntimeError(
          "ACTION_OUTCOME_UNKNOWN",
          "strict click dispatch failed after input may already have affected the page; automatic retry is forbidden",
          {
            phase: error.phase,
            ref: input.ref,
            actionId: input.actionId,
          },
        );
      }

      throw error;
    }

    return {
      actionId: input.actionId,
      status: "executed",
      observedRevision: input.observedRevision,
      ref: input.ref,
      effect,
    };
  }
}
