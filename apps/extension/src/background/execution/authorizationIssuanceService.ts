import {
  BrowserRuntimeError,
  canonicalStrictActionArgs,
  type AuthorizationAssurance,
  type ElementState,
  type StrictActionArgs,
  type StrictKey,
} from "@browser-agent-next/core";
import {
  authorizationAssuranceSatisfies,
  minimumAuthorizationAssurance,
  type AuthorizationGrant,
  type InMemoryAuthorizationStore,
  type MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import type {
  TabStateStore,
} from "@browser-agent-next/runtime";

export interface StrictClickAuthorizationInput {
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  ttlMs: number;
  /** 缺省为 click；写入类动作的参数会被 grant 精确绑定（不变量 138）。 */
  action?: StrictActionArgs;
}

export interface StrictClickAuthorizationResult {
  id: string;
  expiresAt: number;
  origin: string;
  assurance: AuthorizationAssurance;
}

export interface StrictClickAuthorizationIssuanceOptions {
  maxAuthorizationTtlMs?: number;
}

const SOURCE_PROOF: Record<
  AuthorizationGrant["source"],
  AuthorizationAssurance
> = {
  "trusted-host": "control-plane",
  "trusted-ui": "operator-approved",
  "enterprise-policy": "enterprise-policy",
};

/**
 * 写入类动作在签发（以及审批请求入队）之前、按 retained observation 的早期拒绝：
 * 在 grant 被消耗或审批页显示任何值之前挡住明显无效或敏感的目标（不变量 141）。
 */
export function assertStrictActionTarget(
  element: ElementState,
  action: StrictActionArgs,
): void {
  switch (action.kind) {
    case "click":
      return;
    case "setValue":
      requireCapability(element, "setValue");
      rejectSensitive(element, "setValue");
      if (
        element.state.readonly === true ||
        !element.state.enabled ||
        element.semantic.role === "spinbutton" ||
        element.provenance.dom !== true
      ) {
        throw new BrowserRuntimeError(
          "ACTION_NOT_SUPPORTED",
          "setValue supports only enabled, editable native text fields confirmed by DOM perception",
        );
      }
      return;
    case "selectOption":
      requireCapability(element, "selectOption");
      rejectSensitive(element, "selectOption");
      requireEnabledDomTarget(element, "selectOption");
      return;
    case "submit":
      requireCapability(element, "submit");
      requireEnabledDomTarget(element, "submit");
      return;
    case "pressKey":
      rejectSensitive(element, "pressKey");
      requireEnabledDomTarget(element, "pressKey");
      if (keyWouldChangeValue(element, action.key)) {
        throw new BrowserRuntimeError(
          "ACTION_NOT_SUPPORTED",
          "pressKey cannot send this key to a value control; use the matching strict action instead",
        );
      }
      return;
    default: {
      const unknownAction: never = action;
      throw new BrowserRuntimeError(
        "ACTION_NOT_SUPPORTED",
        "strict action kind is not supported: " + String((unknownAction as { kind?: unknown }).kind),
      );
    }
  }
}

function requireCapability(
  element: ElementState,
  kind: "setValue" | "selectOption" | "submit",
): void {
  if (!element.capabilities.some((capability) => capability.kind === kind)) {
    throw new BrowserRuntimeError(
      "TARGET_CAPABILITY_MISSING",
      "the observed target does not accept " + kind,
    );
  }
}

function rejectSensitive(
  element: ElementState,
  kind: "setValue" | "selectOption" | "pressKey",
): void {
  if (element.state.sensitive === true) {
    throw new BrowserRuntimeError(
      "POLICY_BLOCKED",
      kind + " is not allowed on credential or payment fields",
    );
  }
}

function requireEnabledDomTarget(
  element: ElementState,
  kind: "selectOption" | "submit" | "pressKey",
): void {
  if (!element.state.enabled || element.provenance.dom !== true) {
    throw new BrowserRuntimeError(
      "ACTION_NOT_SUPPORTED",
      kind + " supports only enabled targets confirmed by DOM perception",
    );
  }
}

/**
 * 按键本身能改值的组合（不变量 149）：方向键作用于数值 / 滑块 / 单选，Escape 作用于搜索框。
 * 感知按 role 给原生 select 与 ARIA combobox / listbox 同样的 selectOption capability，
 * 签发时无法区分；原生 select 与非文本类 input 由执行时的调用 A 在 focus 之前按 DOM 拒绝。
 */
function keyWouldChangeValue(
  element: ElementState,
  key: StrictKey,
): boolean {
  const role = element.semantic.role;
  if (key === "ArrowUp" || key === "ArrowDown") {
    return role === "spinbutton" || role === "slider" || role === "radio";
  }
  return key === "Escape" && role === "searchbox";
}

/**
 * Strict 动作的统一受信签发核心（历史名称 StrictClick…；现在签发任意 strict 动作）。
 *
 * 外部调用方不能传 assurance/source；每个 public 方法把 provenance 固定在
 * 代码路径上，再统一执行 retained observation、ref、origin、最低 assurance
 * 和 TTL 校验。
 */
export class StrictClickAuthorizationIssuanceService {
  private readonly maxAuthorizationTtlMs: number;

  constructor(
    private readonly states: TabStateStore,
    private readonly authorizations: InMemoryAuthorizationStore,
    private readonly origins: MutableExactOriginAllowlist,
    options: StrictClickAuthorizationIssuanceOptions = {},
  ) {
    this.maxAuthorizationTtlMs =
      options.maxAuthorizationTtlMs ?? 60_000;

    if (
      !Number.isInteger(this.maxAuthorizationTtlMs) ||
      this.maxAuthorizationTtlMs < 1
    ) {
      throw new Error(
        "maxAuthorizationTtlMs must be a positive integer",
      );
    }
  }

  issueControlPlane(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("trusted-host", input);
  }

  issueOperatorApproved(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("trusted-ui", input);
  }

  issueEnterprisePolicy(
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    return this.issue("enterprise-policy", input);
  }

  /**
   * 撤销任意来源的同 id grant；返回是否删除了一个仍有效的 grant。
   * 撤销只减少能力，已消费的 grant 不受影响（点击可能已经发生）。
   */
  revoke(authorizationId: string): boolean {
    return this.authorizations.revoke(authorizationId);
  }

  private issue(
    source: AuthorizationGrant["source"],
    input: StrictClickAuthorizationInput,
  ): StrictClickAuthorizationResult {
    if (
      !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.ttlMs > this.maxAuthorizationTtlMs
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "authorization ttl is outside the allowed range",
      );
    }

    const action: StrictActionArgs = input.action ?? { kind: "click" };
    // 企业 assertion 的签名结构只绑定 click。
    if (source === "enterprise-policy" && action.kind !== "click") {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        "enterprise-policy authorization only covers strict click",
      );
    }

    const stored = this.states.get(
      input.tabId,
      input.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "cannot authorize an observation that is no longer retained",
      );
    }

    const element = stored.byRef.get(input.ref);
    if (!element) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "cannot authorize a ref outside the retained observation",
      );
    }
    assertStrictActionTarget(element, action);

    if (!this.origins.isAllowed(stored.observation.tab.origin)) {
      throw new BrowserRuntimeError(
        "ORIGIN_NOT_ALLOWED",
        "cannot authorize strict click on an origin outside the auto-act allowlist",
      );
    }

    const assurance = SOURCE_PROOF[source];
    const requiredAssurance =
      minimumAuthorizationAssurance(
        "unknown",
        stored.observation.tab.ownedBySession,
      );

    if (
      requiredAssurance !== undefined &&
      !authorizationAssuranceSatisfies(
        assurance,
        requiredAssurance,
      )
    ) {
      throw new BrowserRuntimeError(
        "AUTHORIZATION_REQUIRED",
        source +
          " grant is insufficient for this tab; required assurance: " +
          requiredAssurance,
        {
          requiredAssurance,
          availableAssurance: assurance,
          source,
        },
      );
    }

    const grant = this.authorizations.issue({
      id: input.authorizationId,
      tabId: input.tabId,
      observedRevision: input.observedRevision,
      ref: input.ref,
      actionKind: action.kind,
      actionArgs: canonicalStrictActionArgs(action),
      effectClass: "unknown",
      assurance,
      ttlMs: input.ttlMs,
      singleUse: true,
      source,
    });

    return {
      id: grant.id,
      expiresAt: grant.expiresAt,
      origin: stored.observation.tab.origin,
      assurance: grant.assurance,
    };
  }
}
