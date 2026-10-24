import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  join,
} from "node:path";
import {
  BrowserRuntimeError,
  RUNTIME_ERROR_CODES,
  type BrowserObservation,
  type BrowserObserveInput,
  type BrowserOpenInput,
  type BrowserOpenResult,
  type RuntimeErrorCode,
  type VerificationEvidence,
  type VerificationResult,
  type VerificationSpec,
  type VerifyCondition,
} from "@browser-agent-next/core";
import type {
  ModelBrowserRuntimeClient,
} from "./modelFacingAdapter.js";

export const DEFAULT_TRUSTED_RPC_HOST = "127.0.0.1";
export const DEFAULT_TRUSTED_RPC_PORT = 17_366;
export const DEFAULT_TRUSTED_RPC_TIMEOUT_MS = 15_000;
export const DEFAULT_TRUSTED_RPC_MAX_RESPONSE_BYTES =
  2 * 1024 * 1024;
export const TRUSTED_RPC_TOKEN_REGEX = /^[a-f0-9]{64}$/;

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);
const RUNTIME_CODES = new Set<string>(
  RUNTIME_ERROR_CODES,
);

export interface TrustedRuntimeClientOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  requestId?: () => string;
}

type TrustedSuccess = {
  type: "trusted-host.result";
  requestId: string;
  ok: true;
  result: unknown;
};

type TrustedFailure = {
  type: "trusted-host.result";
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    outcomeMayHaveChanged?: boolean;
  };
};

type TrustedResponse =
  | TrustedSuccess
  | TrustedFailure;
type OperationKind =
  | "open"
  | "observe"
  | "act"
  | "authorize";

export interface TrustedActInput {
  tabId: number;
  actionId: string;
  observedRevision: string;
  ref: string;
  authorizationId: string;
  verification: VerificationSpec;
  verifyTimeoutMs?: number;
}

export interface TrustedStrictClickGrantInput {
  authorizationId: string;
  tabId: number;
  observedRevision: string;
  ref: string;
  ttlMs: number;
}

/**
 * act 在 trusted client 这一层就丢弃 execution 细节、
 * freshRevision 与 postActionObservationError。
 */
export interface TrustedActResult {
  status: "executed";
  verification: VerificationResult;
  verificationAttempts: number;
}

export interface TrustedIssuedAuthorization {
  id: string;
  expiresAt: number;
}

export interface TrustedOperatorApprovalRequest {
  approvalRequestId: string;
  expiresAt: number;
}

export type TrustedOperatorApprovalState =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "invalidated"
  | "cancelled"
  | "unknown";

export interface TrustedOperatorApprovalStatus {
  state: TrustedOperatorApprovalState;
  grantExpiresAt?: number;
}

/**
 * 仅供 model act broker 使用的 trusted Runtime client。
 *
 * 刻意不并入 ModelBrowserRuntimeClient：后者保持只有 open / observe。
 */
export interface TrustedActBrokerRuntimeClient {
  act(input: TrustedActInput): Promise<TrustedActResult>;
  issueStrictClick(
    input: TrustedStrictClickGrantInput,
  ): Promise<TrustedIssuedAuthorization>;
  requestOperatorApproval(
    input: TrustedStrictClickGrantInput,
    approvalTtlMs?: number,
  ): Promise<TrustedOperatorApprovalRequest>;
  operatorApprovalStatus(
    approvalRequestId: string,
  ): Promise<TrustedOperatorApprovalStatus>;
  /**
   * 撤销 authorizationId 对应的 pending approval 与未消费 grant。
   * 成功只表示撤销请求已被扩展处理，不代表点击被阻止。
   */
  cancelStrictClick(
    authorizationId: string,
  ): Promise<void>;
}

const MAX_TEXT = 2_048;
const MAX_REF = 256;
const MAX_ID = 256;
const MAX_EVIDENCE = 20;
const MAX_VERIFICATION_ATTEMPTS = 10_000;
const APPROVAL_STATES = new Set<string>([
  "pending",
  "approved",
  "rejected",
  "expired",
  "invalidated",
  "cancelled",
  "unknown",
]);

function boundedInteger(
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

function assertLoopbackHost(host: string): string {
  const normalized = host.toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(
      "trusted Runtime client only supports explicit loopback hosts",
    );
  }
  return normalized;
}

function assertSecurePathOwnership(
  path: string,
  kind: "directory" | "file",
): Stats {
  const stat = lstatSync(path);

  if (stat.isSymbolicLink()) {
    throw new Error(
      "trusted RPC token " +
        kind +
        " must not be a symlink",
    );
  }

  if (
    kind === "directory"
      ? !stat.isDirectory()
      : !stat.isFile()
  ) {
    throw new Error(
      "trusted RPC token " +
        kind +
        " has an invalid filesystem type",
    );
  }

  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      "trusted RPC token " +
        kind +
        " must be owned by the current user",
    );
  }

  return stat;
}

/**
 * 只读现有 native-host token。
 *
 * MCP 进程永远不能通过这个 helper 创建或轮换 trusted token。
 */
export function readTrustedRpcToken(
  tokenPath = join(
    homedir(),
    ".browser-agent-next",
    "trusted-rpc.token",
  ),
): string {
  const directory = dirname(tokenPath);
  const dirStat = assertSecurePathOwnership(
    directory,
    "directory",
  );
  const tokenStat = assertSecurePathOwnership(
    tokenPath,
    "file",
  );

  if (process.platform !== "win32") {
    if ((dirStat.mode & 0o077) !== 0) {
      throw new Error(
        "trusted RPC token directory permissions are too broad",
      );
    }
    if ((tokenStat.mode & 0o077) !== 0) {
      throw new Error(
        "trusted RPC token file permissions are too broad",
      );
    }
  }

  const token = readFileSync(
    tokenPath,
    "utf8",
  ).trim();

  if (!TRUSTED_RPC_TOKEN_REGEX.test(token)) {
    throw new Error(
      "trusted RPC token file is malformed",
    );
  }

  return token;
}

function record(
  value: unknown,
): Record<string, unknown> | undefined {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(
  value: unknown,
  max = 2_048,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max
  );
}

function isCoverageState(
  value: unknown,
): boolean {
  const item = record(value);
  return !!item &&
    (
      item.status === "complete" ||
      item.status === "truncated" ||
      item.status === "partial" ||
      item.status === "unknown"
    ) &&
    typeof item.returned === "number" &&
    Number.isInteger(item.returned) &&
    item.returned >= 0;
}

function isBrowserObservation(
  value: unknown,
  expectedTabId: number,
): value is BrowserObservation {
  const observation = record(value);
  if (
    !observation ||
    observation.schemaVersion !== 1
  ) {
    return false;
  }

  const tab = record(observation.tab);
  const revision = record(
    observation.revision,
  );
  const scope = record(observation.scope);
  const coverage = record(
    observation.coverage,
  );
  const viewport = record(
    observation.viewport,
  );

  if (
    !tab ||
    !revision ||
    !scope ||
    !coverage ||
    !viewport
  ) {
    return false;
  }

  if (
    tab.tabId !== expectedTabId ||
    typeof tab.title !== "string" ||
    tab.title.length > 8_192 ||
    !boundedString(tab.url, 16_384) ||
    !boundedString(tab.origin, 2_048) ||
    typeof tab.ownedBySession !== "boolean"
  ) {
    return false;
  }

  if (
    !boundedString(revision.id, 256) ||
    !boundedString(
      revision.stateEpoch,
      256,
    ) ||
    !boundedString(
      revision.documentEpoch,
      256,
    ) ||
    typeof revision.sequence !== "number" ||
    !Number.isInteger(revision.sequence) ||
    revision.sequence < 0
  ) {
    return false;
  }

  if (
    scope.kind !== "page" &&
    scope.kind !== "region" &&
    scope.kind !== "ref"
  ) {
    return false;
  }

  const framesCoverage = record(
    coverage.frames,
  );
  const shadowDom = record(
    coverage.shadowDom,
  );
  const canvas = record(
    coverage.canvas,
  );

  if (
    !isCoverageState(
      coverage.actionable,
    ) ||
    !isCoverageState(coverage.forms) ||
    !isCoverageState(coverage.text) ||
    !framesCoverage ||
    !shadowDom ||
    !canvas ||
    !Array.isArray(
      framesCoverage.degraded,
    ) ||
    !framesCoverage.degraded.every(
      (item) => boundedString(item, 512),
    ) ||
    typeof shadowDom.openRootsCovered !==
      "boolean" ||
    typeof shadowDom.closedRootsUnknown !==
      "boolean" ||
    typeof canvas.present !== "boolean" ||
    typeof canvas.semanticallyCovered !==
      "boolean"
  ) {
    return false;
  }

  for (const key of [
    "width",
    "height",
    "scrollX",
    "scrollY",
    "scrollWidth",
    "scrollHeight",
  ]) {
    if (
      typeof viewport[key] !== "number" ||
      !Number.isFinite(viewport[key])
    ) {
      return false;
    }
  }

  if (
    !Array.isArray(observation.frames) ||
    !Array.isArray(
      observation.elements,
    ) ||
    observation.frames.length > 500 ||
    observation.elements.length > 500
  ) {
    return false;
  }

  for (
    const rawFrame of observation.frames
  ) {
    const frame = record(rawFrame);

    if (
      !frame ||
      !boundedString(
        frame.frameId,
        256,
      ) ||
      !boundedString(
        frame.documentEpoch,
        256,
      ) ||
      typeof frame.accessible !==
        "boolean" ||
      (
        frame.parentFrameId !==
          undefined &&
        !boundedString(
          frame.parentFrameId,
          256,
        )
      ) ||
      (
        frame.url !== undefined &&
        (
          typeof frame.url !== "string" ||
          frame.url.length > 16_384
        )
      )
    ) {
      return false;
    }
  }

  for (
    const rawElement of
      observation.elements
  ) {
    const element = record(rawElement);
    const semantic = record(
      element?.semantic,
    );
    const state = record(
      element?.state,
    );

    if (
      !element ||
      !boundedString(
        element.ref,
        256,
      ) ||
      !boundedString(
        element.frameId,
        256,
      ) ||
      !semantic ||
      !boundedString(
        semantic.role,
        256,
      ) ||
      !state ||
      typeof state.visible !==
        "boolean" ||
      typeof state.enabled !==
        "boolean" ||
      typeof state.focused !==
        "boolean" ||
      !Array.isArray(
        element.capabilities,
      ) ||
      !record(element.provenance)
    ) {
      return false;
    }
  }

  return true;
}

function isOpenResult(
  value: unknown,
): value is BrowserOpenResult {
  const result = record(value);

  return !!result &&
    typeof result.tabId === "number" &&
    Number.isInteger(result.tabId) &&
    result.tabId >= 0 &&
    boundedString(
      result.requestedUrl,
      2_048,
    ) &&
    result.ownedBySession === true;
}

function isTrustedResponse(
  value: unknown,
  requestId: string,
): value is TrustedResponse {
  const response = record(value);

  if (
    !response ||
    response.type !==
      "trusted-host.result" ||
    response.requestId !== requestId ||
    typeof response.ok !== "boolean"
  ) {
    return false;
  }

  if (response.ok === true) {
    return "result" in response;
  }

  const error = record(response.error);
  return !!error &&
    boundedString(error.code, 128) &&
    boundedString(error.message, 500) &&
    (
      error.outcomeMayHaveChanged ===
        undefined ||
      typeof error.outcomeMayHaveChanged ===
        "boolean"
    );
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(
    response.headers.get(
      "content-length",
    ),
  );

  if (
    Number.isFinite(declared) &&
    declared > maxBytes
  ) {
    throw new Error(
      "TRUSTED_RESPONSE_TOO_LARGE",
    );
  }

  if (!response.body) return "";

  const reader =
    response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();

      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          "TRUSTED_RESPONSE_TOO_LARGE",
        );
      }

      text += decoder.decode(
        value,
        { stream: true },
      );
    }

    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function knownRuntimeCode(
  value: string,
): value is RuntimeErrorCode {
  return RUNTIME_CODES.has(value);
}

function operationFailure(
  operation: OperationKind,
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    operation === "open" || operation === "act"
      ? "ACTION_OUTCOME_UNKNOWN"
      : operation === "authorize"
        ? "AUTHORIZATION_REQUIRED"
        : "STATE_INCOMPLETE",
    message.slice(0, 500),
  );
}

function nonNegativeInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function optionalText(
  value: unknown,
): value is string | undefined {
  return (
    value === undefined ||
    (
      typeof value === "string" &&
      value.length <= MAX_TEXT
    )
  );
}

/**
 * 逐字段校验并重建 condition，只保留已知字段。
 */
function pickVerifyCondition(
  value: unknown,
): VerifyCondition | undefined {
  const condition = record(value);
  if (!condition) return undefined;

  switch (condition.type) {
    case "url_matches":
    case "title_matches":
      return boundedString(
        condition.pattern,
        MAX_TEXT,
      )
        ? {
            type: condition.type,
            pattern: condition.pattern,
          }
        : undefined;
    case "ref_exists":
    case "ref_visible":
    case "ref_absent":
      return boundedString(
        condition.ref,
        MAX_REF,
      )
        ? {
            type: condition.type,
            ref: condition.ref,
          }
        : undefined;
    case "text_present":
      return boundedString(
        condition.text,
        MAX_TEXT,
      ) &&
        (
          condition.scopeRef ===
            undefined ||
          boundedString(
            condition.scopeRef,
            MAX_REF,
          )
        )
        ? {
            type: "text_present",
            text: condition.text,
            ...(condition.scopeRef !==
            undefined
              ? {
                  scopeRef:
                    condition.scopeRef,
                }
              : {}),
          }
        : undefined;
    case "field_value":
      return boundedString(
        condition.ref,
        MAX_REF,
      )
        ? {
            type: "field_value",
            ref: condition.ref,
            equals: condition.equals,
          }
        : undefined;
    case "dialog_present":
      return optionalText(condition.title)
        ? {
            type: "dialog_present",
            ...(condition.title !==
            undefined
              ? { title: condition.title }
              : {}),
          }
        : undefined;
    case "download_started":
      return optionalText(
        condition.filenamePattern,
      )
        ? {
            type: "download_started",
            ...(condition.filenamePattern !==
            undefined
              ? {
                  filenamePattern:
                    condition.filenamePattern,
                }
              : {}),
          }
        : undefined;
    case "network_request_completed":
      return boundedString(
        condition.urlPattern,
        MAX_TEXT,
      )
        ? {
            type:
              "network_request_completed",
            urlPattern:
              condition.urlPattern,
          }
        : undefined;
    default:
      return undefined;
  }
}

function pickVerificationEvidence(
  value: unknown,
): VerificationEvidence | undefined {
  const evidence = record(value);
  if (
    !evidence ||
    typeof evidence.pass !== "boolean" ||
    typeof evidence.conclusive !==
      "boolean" ||
    !optionalText(evidence.reason)
  ) {
    return undefined;
  }

  const condition = pickVerifyCondition(
    evidence.condition,
  );
  if (!condition) return undefined;

  // observed 与 reason 都是扩展在未投影 observation 上产生的原文（observed 是真实
  // 页面数据，reason 是扩展自由文本）；在 client 层即丢弃，避免任何后续消费者拿到
  // 未出境内容。reason 仍做上界校验，异形响应照旧 fail closed。
  return {
    condition,
    pass: evidence.pass,
    conclusive: evidence.conclusive,
  };
}

function pickVerificationResult(
  value: unknown,
): VerificationResult | undefined {
  const result = record(value);
  if (
    !result ||
    typeof result.verified !== "boolean" ||
    typeof result.conclusive !==
      "boolean" ||
    !Array.isArray(result.evidence) ||
    result.evidence.length > MAX_EVIDENCE ||
    (
      result.revision !== undefined &&
      !boundedString(
        result.revision,
        MAX_ID,
      )
    )
  ) {
    return undefined;
  }

  const evidence: VerificationEvidence[] = [];
  for (const raw of result.evidence) {
    const item = pickVerificationEvidence(raw);
    if (!item) return undefined;
    evidence.push(item);
  }

  return {
    verified: result.verified,
    conclusive: result.conclusive,
    evidence,
    ...(result.revision !== undefined
      ? { revision: result.revision }
      : {}),
  };
}

/**
 * browser.act 响应：只挑出 status / verification / verificationAttempts。
 * execution 细节、freshRevision、postActionObservationError 在此丢弃。
 */
function pickActResult(
  value: unknown,
): TrustedActResult | undefined {
  const result = record(value);
  const execution = record(
    result?.execution,
  );

  if (
    !result ||
    !execution ||
    execution.status !== "executed" ||
    !nonNegativeInteger(
      result.verificationAttempts,
      MAX_VERIFICATION_ATTEMPTS,
    )
  ) {
    return undefined;
  }

  const verification =
    pickVerificationResult(
      result.verification,
    );
  if (!verification) return undefined;

  return {
    status: "executed",
    verification,
    verificationAttempts:
      result.verificationAttempts,
  };
}

function pickIssuedAuthorization(
  value: unknown,
  authorizationId: string,
): TrustedIssuedAuthorization | undefined {
  const result = record(value);

  return result &&
    boundedString(result.id, MAX_ID) &&
    result.id === authorizationId &&
    nonNegativeInteger(result.expiresAt)
    ? {
        id: result.id,
        expiresAt: result.expiresAt,
      }
    : undefined;
}

function pickOperatorApprovalRequest(
  value: unknown,
  authorizationId: string,
): TrustedOperatorApprovalRequest | undefined {
  const result = record(value);

  return result &&
    boundedString(
      result.approvalRequestId,
      MAX_ID,
    ) &&
    nonNegativeInteger(result.expiresAt) &&
    (
      result.authorizationId ===
        undefined ||
      result.authorizationId ===
        authorizationId
    )
    ? {
        approvalRequestId:
          result.approvalRequestId,
        expiresAt: result.expiresAt,
      }
    : undefined;
}

function pickOperatorApprovalStatus(
  value: unknown,
  approvalRequestId: string,
): TrustedOperatorApprovalStatus | undefined {
  const result = record(value);

  if (
    !result ||
    result.approvalRequestId !==
      approvalRequestId ||
    typeof result.state !== "string" ||
    !APPROVAL_STATES.has(result.state) ||
    (
      result.authorizationId !==
        undefined &&
      !boundedString(
        result.authorizationId,
        MAX_ID,
      )
    ) ||
    (
      result.resolvedAt !== undefined &&
      !nonNegativeInteger(result.resolvedAt)
    ) ||
    (
      result.grantExpiresAt !==
        undefined &&
      !nonNegativeInteger(
        result.grantExpiresAt,
      )
    )
  ) {
    return undefined;
  }

  return {
    state:
      result.state as TrustedOperatorApprovalState,
    ...(result.grantExpiresAt !== undefined
      ? {
          grantExpiresAt:
            result.grantExpiresAt,
        }
      : {}),
  };
}

/**
 * 面向 Model-facing Adapter 与 model act broker 的最小 trusted Runtime client。
 *
 * 公共能力只有 browser.open / browser.observe（ModelBrowserRuntimeClient），
 * 以及 act broker 专用的 act / issueStrictClick / requestOperatorApproval /
 * operatorApprovalStatus（TrustedActBrokerRuntimeClient）。
 * 内部 HTTP bridge 不暴露 generic type/payload passthrough。
 */
export class TrustedRuntimeHttpClient
implements
  ModelBrowserRuntimeClient,
  TrustedActBrokerRuntimeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestId: () => string;

  constructor(
    options:
      TrustedRuntimeClientOptions = {},
  ) {
    this.host = assertLoopbackHost(
      options.host ??
        DEFAULT_TRUSTED_RPC_HOST,
    );
    this.port = boundedInteger(
      options.port ??
        DEFAULT_TRUSTED_RPC_PORT,
      "port",
      1,
      65_535,
    );
    this.token =
      options.token !== undefined
        ? assertToken(options.token)
        : readTrustedRpcToken(
            options.tokenPath,
          );
    this.timeoutMs = boundedInteger(
      options.timeoutMs ??
        DEFAULT_TRUSTED_RPC_TIMEOUT_MS,
      "timeoutMs",
      1,
      30_000,
    );
    this.maxResponseBytes =
      boundedInteger(
        options.maxResponseBytes ??
          DEFAULT_TRUSTED_RPC_MAX_RESPONSE_BYTES,
        "maxResponseBytes",
        1_024,
        4 * 1024 * 1024,
      );
    this.fetchImpl =
      options.fetchImpl ?? fetch;
    this.requestId =
      options.requestId ??
      (() => "mcp-" + randomUUID());
  }

  async open(
    input: BrowserOpenInput,
  ): Promise<BrowserOpenResult> {
    const result = await this.call(
      "open",
      {
        type: "browser.open",
        url: input.url,
        ...(input.active !== undefined
          ? { active: input.active }
          : {}),
      },
    );

    if (!isOpenResult(result)) {
      throw operationFailure(
        "open",
        "trusted Runtime returned a malformed browser.open result",
      );
    }

    return result;
  }

  async observe(
    input: BrowserObserveInput,
  ): Promise<BrowserObservation> {
    const result = await this.call(
      "observe",
      {
        type: "browser.observe",
        tabId: input.tabId,
        ...(input.sinceRevision !==
        undefined
          ? {
              sinceRevision:
                input.sinceRevision,
            }
          : {}),
        ...(input.options !== undefined
          ? { options: input.options }
          : {}),
      },
    );

    if (
      !isBrowserObservation(
        result,
        input.tabId,
      )
    ) {
      throw operationFailure(
        "observe",
        "trusted Runtime returned a malformed browser.observe result",
      );
    }

    return result;
  }

  async act(
    input: TrustedActInput,
  ): Promise<TrustedActResult> {
    const result = await this.call(
      "act",
      {
        type: "browser.act",
        tabId: input.tabId,
        action: {
          kind: "click",
          actionId: input.actionId,
          observedRevision:
            input.observedRevision,
          ref: input.ref,
          authorizationId:
            input.authorizationId,
        },
        verification: input.verification,
        ...(input.verifyTimeoutMs !==
        undefined
          ? {
              verifyTimeoutMs:
                input.verifyTimeoutMs,
            }
          : {}),
      },
    );

    const picked = pickActResult(result);
    if (!picked) {
      throw operationFailure(
        "act",
        "trusted Runtime returned a malformed browser.act result",
      );
    }

    return picked;
  }

  async issueStrictClick(
    input: TrustedStrictClickGrantInput,
  ): Promise<TrustedIssuedAuthorization> {
    const result = await this.call(
      "authorize",
      {
        type:
          "authorization.issue-strict-click",
        authorizationId:
          input.authorizationId,
        tabId: input.tabId,
        observedRevision:
          input.observedRevision,
        ref: input.ref,
        ttlMs: input.ttlMs,
      },
    );

    const picked = pickIssuedAuthorization(
      result,
      input.authorizationId,
    );
    if (!picked) {
      throw operationFailure(
        "authorize",
        "trusted Runtime returned a malformed authorization.issue-strict-click result",
      );
    }

    return picked;
  }

  async requestOperatorApproval(
    input: TrustedStrictClickGrantInput,
    approvalTtlMs?: number,
  ): Promise<TrustedOperatorApprovalRequest> {
    const result = await this.call(
      "authorize",
      {
        type:
          "authorization.request-operator-approval",
        authorizationId:
          input.authorizationId,
        tabId: input.tabId,
        observedRevision:
          input.observedRevision,
        ref: input.ref,
        ttlMs: input.ttlMs,
        ...(approvalTtlMs !== undefined
          ? { approvalTtlMs }
          : {}),
      },
    );

    const picked =
      pickOperatorApprovalRequest(
        result,
        input.authorizationId,
      );
    if (!picked) {
      throw operationFailure(
        "authorize",
        "trusted Runtime returned a malformed authorization.request-operator-approval result",
      );
    }

    return picked;
  }

  async operatorApprovalStatus(
    approvalRequestId: string,
  ): Promise<TrustedOperatorApprovalStatus> {
    const result = await this.call(
      "authorize",
      {
        type:
          "authorization.operator-approval-status",
        approvalRequestId,
      },
    );

    const picked =
      pickOperatorApprovalStatus(
        result,
        approvalRequestId,
      );
    if (!picked) {
      throw operationFailure(
        "authorize",
        "trusted Runtime returned a malformed authorization.operator-approval-status result",
      );
    }

    return picked;
  }

  async cancelStrictClick(
    authorizationId: string,
  ): Promise<void> {
    const result = record(
      await this.call(
        "authorize",
        {
          type:
            "authorization.cancel-strict-click",
          authorizationId,
        },
      ),
    );

    if (
      !result ||
      result.authorizationId !==
        authorizationId
    ) {
      throw operationFailure(
        "authorize",
        "trusted Runtime returned a malformed authorization.cancel-strict-click result",
      );
    }
  }

  private async call(
    operation: OperationKind,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId =
      this.requestId();

    if (
      !boundedString(
        requestId,
        256,
      )
    ) {
      throw new Error(
        "requestId generator returned an invalid id",
      );
    }

    const controller =
      new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      let response: Response;

      try {
        response =
          await this.fetchImpl(
            this.endpoint(),
            {
              method: "POST",
              redirect: "error",
              headers: {
                authorization:
                  "Bearer " + this.token,
                "content-type":
                  "application/json",
              },
              body: JSON.stringify({
                ...request,
                requestId,
              }),
              signal:
                controller.signal,
            },
          );
      } catch {
        throw operationFailure(
          operation,
          "trusted Runtime request failed before a valid response was received",
        );
      }

      if (
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 413
      ) {
        throw new BrowserRuntimeError(
          "POLICY_BLOCKED",
          "trusted Runtime rejected the request with HTTP " +
            response.status,
        );
      }

      if (!response.ok) {
        throw operationFailure(
          operation,
          "trusted Runtime returned HTTP " +
            response.status,
        );
      }

      let parsed: unknown;

      try {
        const text =
          await boundedResponseText(
            response,
            this.maxResponseBytes,
          );
        parsed = JSON.parse(text);
      } catch {
        throw operationFailure(
          operation,
          "trusted Runtime returned an invalid or oversized response",
        );
      }

      if (
        !isTrustedResponse(
          parsed,
          requestId,
        )
      ) {
        throw operationFailure(
          operation,
          "trusted Runtime response envelope was invalid",
        );
      }

      // 扩展的错误原文可能描述未出境的页面状态，而这个 client 只服务
      // model-facing MCP：所有路径都只保留 code，message 换成固定文本。
      if (!parsed.ok) {
        if (
          parsed.error
            .outcomeMayHaveChanged ===
          true
        ) {
          throw new BrowserRuntimeError(
            "ACTION_OUTCOME_UNKNOWN",
            "trusted Runtime reported that the " +
              operation +
              " outcome may have changed",
          );
        }

        if (
          knownRuntimeCode(
            parsed.error.code,
          )
        ) {
          throw new BrowserRuntimeError(
            parsed.error.code,
            "trusted Runtime rejected the " +
              operation +
              " request: " +
              parsed.error.code,
          );
        }

        throw operationFailure(
          operation,
          "trusted Runtime returned an unknown error code",
        );
      }

      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(): string {
    const host =
      this.host === "::1"
        ? "[::1]"
        : this.host;

    return (
      "http://" +
      host +
      ":" +
      this.port +
      "/trusted"
    );
  }
}

function assertToken(
  token: string,
): string {
  if (
    !TRUSTED_RPC_TOKEN_REGEX.test(
      token,
    )
  ) {
    throw new Error(
      "trusted RPC token is malformed",
    );
  }

  return token;
}
