import {
  BrowserRuntimeError,
  type BrowserAction,
  type EffectAssessment,
} from "@browser-agent-next/core";
import {
  evaluateEffectPolicy,
  type InMemoryAuthorizationStore,
} from "@browser-agent-next/policy";
import type {
  StoredObservationStrictCoordinator,
} from "@browser-agent-next/runtime";
import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";
import type { ChromeStrictClickDispatcher } from "./chromeStrictClickDispatcher.js";

export interface StrictClickOriginPolicy {
  isAllowed(origin: string): boolean;
}

export interface ExecuteStrictClickInput {
  tabId: number;
  actionId: string;
  observedRevision: string;
  ref: string;

  /**
   * 只能引用 trusted UI / host 已经签发的 grant。
   * 没有 grant 时，unknown-effect click 不会执行。
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

    // Phase 1: prepare once to load trusted observation semantics and ensure
    // the requested target is currently live before we even consider auth.
    const preparedBeforePolicy = await this.coordinator.prepare(
      input.tabId,
      action,
    );

    const effect = conservativeClickEffect();

    const auth = input.authorizationId
      ? this.authorizations.consume({
          id: input.authorizationId,
          tabId: input.tabId,
          observedRevision: input.observedRevision,
          ref: input.ref,
          actionKind: "click",
          effectClass: effect.class,
        })
      : undefined;

    const decision = evaluateEffectPolicy({
      effect,
      tabOwnedBySession:
        preparedBeforePolicy.observation.tab.ownedBySession,
      originAllowed: this.origins.isAllowed(
        preparedBeforePolicy.observation.tab.origin,
      ),
      hasAuthorization: auth?.ok === true,
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
          authorizationReason:
            auth && !auth.ok ? auth.reason : undefined,
        },
      );
    }

    // Phase 2: commit 前再做一次完整 strict prepare。
    // 授权检查期间页面可能变化；绝不能直接复用旧 point。
    const preparedForCommit = await this.coordinator.prepare(
      input.tabId,
      action,
    );

    await this.dispatcher.dispatch(
      preparedForCommit.prepared,
    );

    return {
      actionId: input.actionId,
      status: "executed",
      observedRevision: input.observedRevision,
      ref: input.ref,
      effect,
    };
  }
}
