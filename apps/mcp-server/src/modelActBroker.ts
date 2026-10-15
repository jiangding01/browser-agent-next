import { randomUUID } from "node:crypto";
import {
  BrowserRuntimeError,
  type BrowserObservation,
} from "@browser-agent-next/core";
import { ExactOriginAllowlist } from "@browser-agent-next/policy";
import type { ModelActApprovalMode } from "./mcpConfig.js";
import type { ModelActInput } from "./modelToolInput.js";
import type {
  TrustedActBrokerRuntimeClient,
  TrustedStrictClickGrantInput,
} from "./trustedRuntimeClient.js";

export const MODEL_ACT_GRANT_TTL_MS = 30_000;
export const MODEL_ACT_APPROVAL_POLL_INTERVAL_MS = 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_ACT_BUDGET = 256;

export interface ModelActBrokerOptions {
  actOrigins: readonly string[];
  budget: number;
  approvalMode: ModelActApprovalMode;
  approvalTimeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
}

/**
 * broker 只负责授权与执行，结果只说明“已执行、效果未知”。
 *
 * 扩展返回的 verification / verificationAttempts 是在未经出境投影的
 * fresh observation 上计算的，可能编码隐藏 frame、redacted value 或
 * 非 read origin URL，因此在这里整体丢弃；模型可见的 verification 由 adapter
 * 在已投影、已入出境 store 的 observation 上本地重算。
 */
export interface ModelActExecution {
  status: "executed";
  effectClass: "unknown";
}

export interface ModelActBroker {
  act(
    input: ModelActInput,
    observation: BrowserObservation,
  ): Promise<ModelActExecution>;
}

function boundedOption(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      name +
        " must be an integer between " +
        min +
        " and " +
        max,
    );
  }

  return value;
}

/**
 * 解析 element 所在 frame 的有效 origin。
 *
 * 与 model-egress 投影相同：about:blank / about:srcdoc 继承父 frame，
 * 顶层 frame 缺 url 时回落到 tab origin；其余缺 url 的 frame 视为未知。
 */
function elementFrameUrl(
  observation: BrowserObservation,
  frameId: string,
): string | undefined {
  const frames = new Map(
    observation.frames.map((frame) => [
      frame.frameId,
      frame,
    ]),
  );
  const seen = new Set<string>();
  let current = frames.get(frameId);

  while (current && !seen.has(current.frameId)) {
    seen.add(current.frameId);

    if (current.parentFrameId === undefined) {
      return current.url ?? observation.tab.origin;
    }
    if (
      current.url === "about:blank" ||
      current.url === "about:srcdoc"
    ) {
      current = frames.get(current.parentFrameId);
      continue;
    }
    return current.url;
  }

  return undefined;
}

/**
 * trusted Runtime 的错误 message 来自扩展原文，可能描述未出境的页面状态；
 * 只保留 code，message 换成固定文本。broker 自身产生的错误不经过这里。
 */
function sanitizedRuntimeError(
  error: unknown,
  stage: "authorization" | "execution",
): unknown {
  if (!(error instanceof BrowserRuntimeError)) {
    return error;
  }

  return new BrowserRuntimeError(
    error.code,
    "trusted Runtime rejected browser.act " +
      stage +
      ": " +
      error.code,
  );
}

/**
 * MCP 进程内的 model act broker。
 *
 * 模型只能提出“点击某个已出境 ref”，授权 id、action id 与授权路径都由这里生成：
 * - act origin 是独立于 read/navigation 的 plane；
 * - 每个连接有独立预算，同一 (tab, revision, ref) 至多发起一次，标记先于 dispatch；
 * - 默认 operator approval；agent-owned-auto 仅对 ownedBySession 且未降级的 tab 生效；
 * - ACTION_OUTCOME_UNKNOWN 后该 tab 永久降级为 operator approval。
 */
export function createModelActBroker(
  runtime: TrustedActBrokerRuntimeClient,
  options: ModelActBrokerOptions,
): ModelActBroker {
  const origins = new ExactOriginAllowlist(
    options.actOrigins,
  );
  const approvalTimeoutMs = boundedOption(
    options.approvalTimeoutMs,
    "approvalTimeoutMs",
    1,
    MAX_APPROVAL_TIMEOUT_MS,
  );
  const approvalMode = options.approvalMode;
  if (
    approvalMode !== "operator" &&
    approvalMode !== "agent-owned-auto"
  ) {
    throw new Error(
      "approvalMode must be operator or agent-owned-auto",
    );
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  );
  const uuid = options.uuid ?? randomUUID;

  let remainingBudget = boundedOption(
    options.budget,
    "budget",
    1,
    MAX_ACT_BUDGET,
  );
  const consumed = new Set<string>();
  const degradedTabs = new Set<number>();

  async function authorizationCall<T>(
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw sanitizedRuntimeError(
        error,
        "authorization",
      );
    }
  }

  async function awaitOperatorApproval(
    grant: TrustedStrictClickGrantInput,
  ): Promise<void> {
    const deadline = now() + approvalTimeoutMs;
    const request = await authorizationCall(() =>
      runtime.requestOperatorApproval(grant)
    );

    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new BrowserRuntimeError(
          "AUTHORIZATION_REQUIRED",
          "operator approval timed out",
        );
      }
      await sleep(
        Math.min(
          MODEL_ACT_APPROVAL_POLL_INTERVAL_MS,
          remaining,
        ),
      );

      const status = await authorizationCall(() =>
        runtime.operatorApprovalStatus(
          request.approvalRequestId,
        )
      );
      switch (status.state) {
        case "pending":
          continue;
        case "approved":
          return;
        case "rejected":
          throw new BrowserRuntimeError(
            "AUTHORIZATION_REQUIRED",
            "operator rejected the click",
          );
        case "expired":
          throw new BrowserRuntimeError(
            "AUTHORIZATION_REQUIRED",
            "operator approval request expired",
          );
        case "invalidated":
          throw new BrowserRuntimeError(
            "AUTHORIZATION_REQUIRED",
            "operator approval was invalidated by a page change",
          );
        default:
          throw new BrowserRuntimeError(
            "AUTHORIZATION_REQUIRED",
            "operator approval state is unknown",
          );
      }
    }
  }

  async function act(
    input: ModelActInput,
    observation: BrowserObservation,
  ): Promise<ModelActExecution> {
    // 0. adapter 传入的 observation 必须与入参绑定一致（纵深防御）。
    if (
      observation.tab.tabId !== input.tabId ||
      observation.revision.id !==
        input.observedRevision
    ) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "browser.act observation does not match the requested tab revision",
      );
    }
    const element = observation.elements.find(
      (item) => item.ref === input.ref,
    );
    if (!element) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "browser.act ref was not exposed in the observed revision",
      );
    }

    // 1. act origin plane：顶层 tab 与目标 element 所在 frame 都必须在 act allowlist 内。
    const frameUrl = elementFrameUrl(
      observation,
      element.frameId,
    );
    if (
      !origins.isAllowed(observation.tab.origin) ||
      frameUrl === undefined ||
      !origins.isAllowed(frameUrl)
    ) {
      throw new BrowserRuntimeError(
        "ORIGIN_NOT_ALLOWED",
        "model act origin is not allowlisted",
      );
    }

    // 2. per-connection 预算。
    if (remainingBudget <= 0) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "model act budget exhausted for this connection",
      );
    }
    remainingBudget -= 1;

    // 3. 同一 (tab, revision, ref) 至多一次；先落账，此后任何失败都不回滚。
    const key = JSON.stringify([
      input.tabId,
      input.observedRevision,
      input.ref,
    ]);
    if (consumed.has(key)) {
      throw new BrowserRuntimeError(
        "POLICY_BLOCKED",
        "model act was already attempted for this tab revision and ref",
      );
    }
    consumed.add(key);

    const grant: TrustedStrictClickGrantInput = {
      authorizationId: uuid(),
      tabId: input.tabId,
      observedRevision: input.observedRevision,
      ref: input.ref,
      ttlMs: MODEL_ACT_GRANT_TTL_MS,
    };

    try {
      // 4. 授权路径。
      if (
        approvalMode === "agent-owned-auto" &&
        observation.tab.ownedBySession === true &&
        !degradedTabs.has(input.tabId)
      ) {
        await authorizationCall(() =>
          runtime.issueStrictClick(grant)
        );
      } else {
        await awaitOperatorApproval(grant);
      }

      // 5. 执行。verifyTimeoutMs 恒为 0：扩展只做一次验证、不轮询，
      // act 耗时不随隐藏状态变化。verification spec 仅因扩展协议要求非空而传入，
      // 其返回值整体丢弃，不参与任何返回值或分支判断。
      try {
        await runtime.act({
          tabId: input.tabId,
          actionId: uuid(),
          observedRevision: input.observedRevision,
          ref: input.ref,
          authorizationId: grant.authorizationId,
          verification: input.verification,
          verifyTimeoutMs: 0,
        });
      } catch (error) {
        throw sanitizedRuntimeError(
          error,
          "execution",
        );
      }

      // 7. 只返回“已执行、效果未知”。
      return {
        status: "executed",
        effectClass: "unknown",
      };
    } catch (error) {
      // 6. 结果未知后该 tab 永久降级为 operator approval。
      if (
        !(error instanceof BrowserRuntimeError) ||
        error.code === "ACTION_OUTCOME_UNKNOWN"
      ) {
        degradedTabs.add(input.tabId);
      }
      throw error;
    }
  }

  return { act };
}
