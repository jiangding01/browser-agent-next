import { BrowserRuntimeError } from "@browser-agent-next/core";
import { DOM_IDENTITY_BRIDGE_KEY } from "../../protocol/identityBridge.js";
import { SENSITIVE_AUTOCOMPLETE_PATTERN } from "../../protocol/sensitiveFields.js";
import type { RuntimeExecutionContext } from "../chrome/chromeDebuggerTransport.js";

interface RuntimeRemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeCallResult {
  result: RuntimeRemoteObject;
  exceptionDetails?: unknown;
}

export interface StrictValueWriterTransport {
  attach(tabId: number): Promise<void>;
  contextsForFrame(
    tabId: number,
    cdpFrameId: string,
  ): RuntimeExecutionContext[];
  send<T>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

export interface StrictValueWriteTarget {
  tabId: number;
  /** 必须是 root session 中的帧；OOPIF child session 由执行器在此之前拒绝。 */
  cdpFrameId: string;
  frameEpoch: string;
  stableId: string;
}

export interface StrictValueWriteResult {
  /** 写入后字段的值是否与请求完全相等（maxlength、格式化、掩码会让它为 false）。 */
  valueMatched: boolean;
}

export interface StrictValueWriter {
  write(
    target: StrictValueWriteTarget,
    value: string,
  ): Promise<StrictValueWriteResult>;
}

const TEXT_INPUT_TYPES = ["text", "search", "email", "url", "tel"];

/**
 * 在扩展 isolated world 中、单一 JS task 内执行的写入函数（不变量 140）。
 *
 * 焦点确认、字段复核与插入之间不让出 task：页面脚本没有机会把焦点移到别的元素，
 * 文字要么进入由 stableId 解析出的那个元素，要么不进入任何元素。
 * 只接受 stableId 与值两个参数，不执行任何调用方提供的代码。
 */
export const STRICT_SET_VALUE_FUNCTION = String.raw`function(stableId, value) {
  const element = this.resolve(stableId);
  if (!element || !element.isConnected) {
    return { status: "rejected", reason: "missing" };
  }

  const textTypes = ${JSON.stringify(TEXT_INPUT_TYPES)};
  const sensitiveAutocomplete = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_PATTERN)});
  const view = element.ownerDocument.defaultView;

  const check = () => {
    const isTextarea = element instanceof view.HTMLTextAreaElement;
    const isInput = element instanceof view.HTMLInputElement;
    if (!isTextarea && !isInput) return "unsupported";

    if (isInput) {
      const type = element.type.toLowerCase();
      const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
      if (type === "password" || sensitiveAutocomplete.test(autocomplete)) {
        return "sensitive";
      }
      if (!textTypes.includes(type)) return "unsupported";
    }

    if (
      element.readOnly ||
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.closest("[inert]")
    ) {
      return "unsupported";
    }

    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    if (
      element.closest("[hidden]") ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return "unsupported";
    }

    return undefined;
  };

  const before = check();
  if (before !== undefined) {
    return { status: "rejected", reason: before };
  }

  // 从这里开始页面回调可能已经运行：之后的任何异常都是 outcome unknown。
  element.focus({ preventScroll: true });
  if (element.getRootNode().activeElement !== element) {
    return { status: "focus-lost" };
  }
  if (check() !== undefined) {
    return { status: "changed-during-focus" };
  }

  // execCommand("delete") 在空字段上返回 false；清空一个本来就空的字段不是失败。
  if (value === "" && element.value === "") {
    return { status: "written", accepted: true, valueMatched: true };
  }

  element.select();
  const accepted = value === ""
    ? element.ownerDocument.execCommand("delete")
    : element.ownerDocument.execCommand("insertText", false, value);

  return {
    status: "written",
    accepted: accepted === true,
    valueMatched: element.value === value,
  };
}`;

const BRIDGE_META_FUNCTION =
  "function(){return {version:this.version,frameEpoch:this.frameEpoch};}";

let writeGroupSequence = 0;

function nextObjectGroup(tabId: number): string {
  writeGroupSequence += 1;
  return "browser-agent-next-strict-write:t" + tabId + ":" + writeGroupSequence;
}

/** 调用写入函数之前的失败：页面尚未被触碰，安全。 */
function beforeWrite(message: string): BrowserRuntimeError {
  return new BrowserRuntimeError("TARGET_IDENTITY_MISMATCH", message);
}

/** 写入函数已经（或可能已经）运行：focus 可能已发生，禁止自动重试（不变量 145）。 */
function outcomeUnknown(message: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "ACTION_OUTCOME_UNKNOWN",
    "strict setValue " + message + "; input may already have affected the page, automatic retry is forbidden",
  );
}

/**
 * 在扩展 isolated world 中执行 Strict setValue。
 *
 * 只使用目标帧中唯一的、属于本扩展的 isolated world（不变量 140）：写入函数一旦在某个
 * 上下文运行过，就不能再换一个上下文重试，因此不复用只读检查器“逐个上下文尝试”的循环。
 * 结果与错误都不包含值本身（不变量 144）。
 */
export class IsolatedWorldStrictValueWriter implements StrictValueWriter {
  constructor(
    private readonly transport: StrictValueWriterTransport,
    private readonly extensionOrigin: string,
  ) {}

  async write(
    target: StrictValueWriteTarget,
    value: string,
  ): Promise<StrictValueWriteResult> {
    await this.transport.attach(target.tabId);

    const contexts = this.transport
      .contextsForFrame(target.tabId, target.cdpFrameId)
      .filter(
        (context) =>
          context.auxData?.type === "isolated" &&
          context.origin === this.extensionOrigin,
      );

    if (contexts.length !== 1) {
      throw beforeWrite(
        "strict setValue requires exactly one extension isolated world in the target frame",
      );
    }
    const context = contexts[0]!;
    const objectGroup = nextObjectGroup(target.tabId);

    try {
      const bridgeObjectId = await this.bridgeObjectId(
        target,
        context.id,
        objectGroup,
      );

      let written: RuntimeCallResult;
      try {
        written = await this.transport.send<RuntimeCallResult>(
          target.tabId,
          "Runtime.callFunctionOn",
          {
            objectId: bridgeObjectId,
            functionDeclaration: STRICT_SET_VALUE_FUNCTION,
            arguments: [{ value: target.stableId }, { value }],
            objectGroup,
            returnByValue: true,
            silent: true,
          },
        );
      } catch {
        throw outcomeUnknown("call failed after it may have been dispatched");
      }

      if (written.exceptionDetails) {
        throw outcomeUnknown("threw inside the page");
      }

      return interpretWriteResult(written.result.value);
    } finally {
      try {
        await this.transport.send(target.tabId, "Runtime.releaseObjectGroup", {
          objectGroup,
        });
      } catch {
        // 仅影响临时 remote object 回收。
      }
    }
  }

  private async bridgeObjectId(
    target: StrictValueWriteTarget,
    contextId: number,
    objectGroup: string,
  ): Promise<string> {
    let bridge: RuntimeCallResult;
    let meta: RuntimeCallResult;
    try {
      bridge = await this.transport.send<RuntimeCallResult>(
        target.tabId,
        "Runtime.evaluate",
        {
          expression:
            "globalThis[" + JSON.stringify(DOM_IDENTITY_BRIDGE_KEY) + "] ?? null",
          contextId,
          objectGroup,
          returnByValue: false,
          silent: true,
        },
      );
      const objectId = bridge.result.objectId;
      if (!objectId || bridge.exceptionDetails) {
        throw beforeWrite("strict setValue identity bridge is unavailable");
      }

      meta = await this.transport.send<RuntimeCallResult>(
        target.tabId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: BRIDGE_META_FUNCTION,
          objectGroup,
          returnByValue: true,
          silent: true,
        },
      );
      const metaValue = meta.result.value as
        | { version?: unknown; frameEpoch?: unknown }
        | undefined;
      if (
        meta.exceptionDetails ||
        metaValue?.version !== 1 ||
        metaValue.frameEpoch !== target.frameEpoch
      ) {
        throw beforeWrite("strict setValue identity bridge does not match the observed frame");
      }

      return objectId;
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw beforeWrite("strict setValue could not reach the identity bridge");
    }
  }
}

/** 写入函数返回值 → 执行结果或错误码（docs/STRICT-WRITE-ACTIONS.md「结果映射」）。 */
export function interpretWriteResult(value: unknown): StrictValueWriteResult {
  const result =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;

  switch (result?.status) {
    case "rejected":
      if (result.reason === "sensitive") {
        throw new BrowserRuntimeError(
          "POLICY_BLOCKED",
          "strict setValue is not allowed on credential or payment fields",
        );
      }
      if (result.reason === "missing") {
        throw beforeWrite("strict setValue target no longer resolves to a connected element");
      }
      if (result.reason === "unsupported") {
        throw new BrowserRuntimeError(
          "ACTION_NOT_SUPPORTED",
          "strict setValue supports only enabled, editable, visible native single-line text fields",
        );
      }
      break;
    case "focus-lost":
      throw outcomeUnknown("lost focus to another element after focusing the target");
    case "changed-during-focus":
      throw outcomeUnknown("target field changed while it was being focused");
    case "written":
      if (
        typeof result.accepted === "boolean" &&
        typeof result.valueMatched === "boolean"
      ) {
        if (!result.accepted) {
          throw outcomeUnknown("edit command was rejected by the browser");
        }
        return { valueMatched: result.valueMatched };
      }
      break;
  }

  throw outcomeUnknown("returned an unexpected result");
}
