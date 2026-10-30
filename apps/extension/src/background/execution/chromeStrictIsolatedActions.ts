import {
  BrowserRuntimeError,
  type RuntimeErrorCode,
  type StrictActionArgs,
  type StrictKey,
} from "@browser-agent-next/core";
import { DOM_IDENTITY_BRIDGE_KEY } from "../../protocol/identityBridge.js";
import { IMPLICIT_SUBMISSION_BLOCKING_TYPES } from "../../protocol/implicitSubmission.js";
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

export interface StrictIsolatedActionTransport {
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

export interface StrictIsolatedActionTarget {
  tabId: number;
  /** 必须是 root session 中的帧；OOPIF child session 由执行器在此之前拒绝。 */
  cdpFrameId: string;
  frameEpoch: string;
  stableId: string;
}

/** 由 isolated world 执行的 strict 动作：除 click 以外的全部动作。 */
export type StrictIsolatedActionArgs = Exclude<
  StrictActionArgs,
  { kind: "click" }
>;

export interface StrictIsolatedActionResult {
  /**
   * 仅 setValue / selectOption：动作后字段的值是否与请求完全相等
   * （maxlength、格式化、页面 change 处理器会让它为 false）。
   */
  valueMatched?: boolean;
}

export interface StrictIsolatedActionRunner {
  run(
    target: StrictIsolatedActionTarget,
    args: StrictIsolatedActionArgs,
  ): Promise<StrictIsolatedActionResult>;
}

const TEXT_INPUT_TYPES = ["text", "search", "email", "url", "tel"];


/** pressKey 监听器表在 isolated world 全局上的键名；页面世界无法访问。 */
const KEY_PROBE_REGISTRY = "__browserAgentNextStrictKeyProbes";

/** 监听器在调用 B 未到达时的自清理时间。 */
const KEY_PROBE_TTL_MS = 5_000;

const KEY_DEFINITIONS: Record<
  StrictKey,
  { code: string; keyCode: number }
> = {
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

/**
 * 每个页面函数共用的检查：可见、启用、敏感字段判定（与感知层 isSensitiveField 相同）。
 * 只读 DOM，不运行页面代码；isolated world 的 DOM 包装对象不受页面改写原型影响。
 */
const COMMON_CHECKS = String.raw`
  // Document 实例的属性可被同名命名元素覆盖，一律经原型读取（不变量 151）。
  const doc = element.ownerDocument;
  const view = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView").get.call(doc);
  const sensitiveAutocomplete = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_PATTERN)});

  const isSensitive = () => {
    const isInput = element instanceof view.HTMLInputElement;
    if (
      !isInput &&
      !(element instanceof view.HTMLTextAreaElement) &&
      !(element instanceof view.HTMLSelectElement)
    ) {
      return false;
    }
    if (isInput && element.type.toLowerCase() === "password") return true;
    if (sensitiveAutocomplete.test((element.getAttribute("autocomplete") || "").toLowerCase())) {
      return true;
    }
    const masking = view
      .getComputedStyle(element)
      .getPropertyValue("-webkit-text-security")
      .trim();
    return masking !== "" && masking !== "none";
  };

  // 焦点是否就在 element 上：getRootNode 与 activeElement 一律经原型读取（不变量 151）。
  const focusedHere = () => {
    const root = view.Node.prototype.getRootNode.call(element);
    const proto = root instanceof view.Document ? view.Document.prototype : view.ShadowRoot.prototype;
    return Object.getOwnPropertyDescriptor(proto, "activeElement").get.call(root) === element;
  };

  const visibleAndEnabled = () => {
    if (
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.closest("[inert]")
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    return !(
      element.closest("[hidden]") ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      rect.width <= 0 ||
      rect.height <= 0
    );
  };
`;

/**
 * Strict setValue：在扩展 isolated world 中、单一 JS task 内执行（不变量 140）。
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
  ${COMMON_CHECKS}
  const textTypes = ${JSON.stringify(TEXT_INPUT_TYPES)};

  const check = () => {
    const isTextarea = element instanceof view.HTMLTextAreaElement;
    const isInput = element instanceof view.HTMLInputElement;
    if (!isTextarea && !isInput) return "unsupported";
    if (isSensitive()) return "sensitive";
    if (isInput && !textTypes.includes(element.type.toLowerCase())) {
      return "unsupported";
    }
    if (element.readOnly || !visibleAndEnabled()) return "unsupported";
    return undefined;
  };

  const before = check();
  if (before !== undefined) {
    return { status: "rejected", reason: before };
  }

  // 从这里开始页面回调可能已经运行：之后的任何异常都是 outcome unknown。
  element.focus({ preventScroll: true });
  if (!focusedHere()) {
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
  // 经原型调用，页面的命名元素无法替换它（不变量 151）。
  const execCommand = view.Document.prototype.execCommand;
  const accepted = value === ""
    ? execCommand.call(doc, "delete")
    : execCommand.call(doc, "insertText", false, value);

  return {
    status: "written",
    accepted: accepted === true,
    valueMatched: element.value === value,
  };
}`;

/**
 * Strict selectOption：原生单选 select，按 option.label 精确匹配（不变量 147）。
 *
 * 不 focus：设置选中项之前没有任何页面代码运行。选项不存在或不唯一时在修改之前拒绝。
 */
export const STRICT_SELECT_OPTION_FUNCTION = String.raw`function(stableId, label) {
  const element = this.resolve(stableId);
  if (!element || !element.isConnected) {
    return { status: "rejected", reason: "missing" };
  }
  ${COMMON_CHECKS}

  // size > 1 的 select 在页面内渲染为列表，选项可被页面 CSS 改写显示内容。
  if (!(element instanceof view.HTMLSelectElement) || element.multiple || element.size > 1) {
    return { status: "rejected", reason: "unsupported" };
  }
  if (isSensitive()) {
    return { status: "rejected", reason: "sensitive" };
  }
  if (
    !visibleAndEnabled() ||
    view.getComputedStyle(element).getPropertyValue("appearance").trim() === "base-select"
  ) {
    return { status: "rejected", reason: "unsupported" };
  }

  // 选项自身与它到 select 之间的 optgroup 都不能被隐藏：选项自身的计算样式不反映 optgroup。
  const hiddenWithinSelect = (node) => {
    for (let current = node; current && current !== element; current = current.parentElement) {
      if (current.hidden || view.getComputedStyle(current).display === "none") return true;
    }
    return false;
  };

  const candidates = Array.from(element.options).filter((option) =>
    !option.matches(":disabled") &&
    !hiddenWithinSelect(option) &&
    option.children.length === 0 &&
    (!option.hasAttribute("label") || option.getAttribute("label") === option.text) &&
    option.label === label
  );

  if (candidates.length === 0) {
    return { status: "rejected", reason: "option-not-found" };
  }
  if (candidates.length > 1) {
    return { status: "rejected", reason: "option-ambiguous" };
  }

  const option = candidates[0];
  // 与用户重新选择同一项一致：不派发事件。
  if (option.selected) {
    return { status: "written", valueMatched: true };
  }

  // 从这里开始页面的事件处理器会运行：之后的任何异常都是 outcome unknown。
  element.selectedIndex = option.index;
  element.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));

  const selected = element.selectedOptions;
  return {
    status: "written",
    valueMatched: selected.length === 1 && selected[0] === option,
  };
}`;

/**
 * Strict submit：只提交字段自身所在、没有任何提交按钮、且目标是其中唯一阻止隐式提交的
 * 字段的表单——即用户在该字段中按 Enter 会提交的表单（不变量 148）。
 *
 * 表单对象的属性与方法一律经原型访问，同名控件无法覆盖（不变量 151）；
 * 有效性预检是纯读取，失败时页面代码尚未运行；只以观察到的可信 submit 事件为准。
 */
export const STRICT_SUBMIT_FUNCTION = String.raw`function(stableId) {
  const element = this.resolve(stableId);
  if (!element || !element.isConnected) {
    return { status: "rejected", reason: "missing" };
  }
  ${COMMON_CHECKS}

  const implicitTypes = ${JSON.stringify(IMPLICIT_SUBMISSION_BLOCKING_TYPES)};
  const blocksImplicitSubmission = (control) =>
    control instanceof view.HTMLInputElement &&
    implicitTypes.includes(control.type.toLowerCase());

  if (!blocksImplicitSubmission(element) || !visibleAndEnabled()) {
    return { status: "rejected", reason: "unsupported" };
  }

  const form = element.form;
  if (!form || form !== element.closest("form")) {
    return { status: "rejected", reason: "not-own-form" };
  }

  const formProto = view.HTMLFormElement.prototype;
  const formGetter = (name) => Object.getOwnPropertyDescriptor(formProto, name).get;
  const controls = Array.from(formGetter("elements").call(form));

  // 表单的 elements 不含 input type=image，单独按 form owner 查找；
  // form owner 与表单在同一个 tree 中，只需查表单所在的 document 或 shadow root。
  const root = view.Node.prototype.getRootNode.call(form);
  const query =
    root instanceof view.Document
      ? view.Document.prototype.querySelectorAll
      : view.DocumentFragment.prototype.querySelectorAll;
  const inputs = Array.from(query.call(root, "input"));
  const hasSubmitButton =
    controls.some((control) =>
      control instanceof view.HTMLButtonElement
        ? control.type === "submit"
        : control instanceof view.HTMLInputElement &&
          ["submit", "image"].includes(control.type.toLowerCase())
    ) ||
    inputs.some((input) => input.type.toLowerCase() === "image" && input.form === form);
  if (hasSubmitButton) {
    return { status: "rejected", reason: "has-submit-button" };
  }

  // HTML 隐式提交：没有提交按钮时，只有表单中恰好一个阻止隐式提交的字段，按 Enter 才会提交；
  // 否则 requestSubmit 会提交一个用户按 Enter 也提交不了的表单，与审批说明不符。
  if (controls.filter(blocksImplicitSubmission).length !== 1) {
    return { status: "rejected", reason: "no-implicit-submission" };
  }

  // form-associated custom element 经 ElementInternals 校验，isolated world 读不到它的 validity。
  if (controls.some((control) => typeof control.willValidate !== "boolean" || !control.validity)) {
    return { status: "rejected", reason: "custom-control" };
  }

  if (
    !formGetter("noValidate").call(form) &&
    controls.some((control) => control.willValidate && !control.validity.valid)
  ) {
    return { status: "rejected", reason: "form-invalid" };
  }

  // 从这里开始页面的 submit 处理器会运行：之后的任何异常都是 outcome unknown。
  let observed = 0;
  const listener = (event) => {
    if (event.isTrusted && event.target === form) observed += 1;
  };
  const eventTarget = view.EventTarget.prototype;
  eventTarget.addEventListener.call(form, "submit", listener, true);
  try {
    formProto.requestSubmit.call(form);
  } finally {
    eventTarget.removeEventListener.call(form, "submit", listener, true);
  }

  return observed === 1 ? { status: "submitted" } : { status: "not-observed" };
}`;

/**
 * Strict pressKey 调用 A：检查目标、布防 keydown 监听器、focus 并确认（不变量 149）。
 *
 * 监听器在 focus 之前注册，记录每个可信且 key 相符的 keydown 是否落在该元素上；
 * 调用 B 据此判定按键是否送达。监听器表在 isolated world 全局上，页面无法访问。
 */
export const STRICT_KEY_ARM_FUNCTION = String.raw`function(stableId, key, token) {
  const element = this.resolve(stableId);
  if (!element || !element.isConnected) {
    return { status: "rejected", reason: "missing" };
  }
  ${COMMON_CHECKS}
  const textTypes = ${JSON.stringify(TEXT_INPUT_TYPES)};

  // 按键本身能改值：方向键改变原生值控件，Escape 清空 search 输入框。
  const check = () => {
    if (isSensitive()) return "sensitive";
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (element instanceof view.HTMLSelectElement) return "unsupported";
      if (
        element instanceof view.HTMLInputElement &&
        !textTypes.includes(element.type.toLowerCase())
      ) {
        return "unsupported";
      }
    }
    if (
      key === "Escape" &&
      element instanceof view.HTMLInputElement &&
      element.type.toLowerCase() === "search"
    ) {
      return "unsupported";
    }
    if (!visibleAndEnabled()) return "unsupported";
    // 焦点委托会让 activeElement 与 composedPath 被重定向成 host，按键实际落在 shadow 内的控件上；
    // frame owner 把按键送进子帧。两者都无法证明按键只作用于被识别的目标。
    const domApi = globalThis.chrome && globalThis.chrome.dom;
    if (!domApi || typeof domApi.openOrClosedShadowRoot !== "function") return "unsupported";
    if (domApi.openOrClosedShadowRoot(element)) return "unsupported";
    if (
      element instanceof view.HTMLIFrameElement ||
      element instanceof view.HTMLFrameElement ||
      element instanceof view.HTMLObjectElement ||
      element instanceof view.HTMLEmbedElement
    ) {
      return "unsupported";
    }
    const focusable =
      element.tabIndex >= 0 ||
      element.hasAttribute("tabindex") ||
      element.isContentEditable;
    return focusable ? undefined : "unsupported";
  };

  const before = check();
  if (before !== undefined) {
    return { status: "rejected", reason: before };
  }

  const registry =
    globalThis[${JSON.stringify(KEY_PROBE_REGISTRY)}] ||
    (globalThis[${JSON.stringify(KEY_PROBE_REGISTRY)}] = new Map());
  const records = [];
  const listener = (event) => {
    if (event.isTrusted && event.key === key) {
      records.push(event.composedPath()[0] === element);
    }
  };
  const eventTarget = view.EventTarget.prototype;
  const cleanup = () => {
    eventTarget.removeEventListener.call(view, "keydown", listener, true);
    registry.delete(token);
  };
  eventTarget.addEventListener.call(view, "keydown", listener, true);
  const timer = setTimeout(cleanup, ${KEY_PROBE_TTL_MS});
  registry.set(token, { records, cleanup, timer });

  const disarm = () => {
    clearTimeout(timer);
    cleanup();
  };

  // 从这里开始页面回调可能已经运行：之后的任何失败都是 outcome unknown。
  element.focus({ preventScroll: true });
  if (!focusedHere()) {
    disarm();
    return { status: "focus-lost" };
  }
  if (check() !== undefined) {
    disarm();
    return { status: "changed-during-focus" };
  }

  return { status: "armed" };
}`;

/** Strict pressKey 调用 B：取出记录并移除监听器。 */
export const STRICT_KEY_READ_FUNCTION = String.raw`function(token) {
  const registry = globalThis[${JSON.stringify(KEY_PROBE_REGISTRY)}];
  const entry = registry && registry.get(token);
  if (!entry) {
    return { status: "expired" };
  }
  clearTimeout(entry.timer);
  entry.cleanup();
  const records = entry.records;
  return records.length === 1 && records[0] === true
    ? { status: "pressed" }
    : { status: "misrouted", count: records.length };
}`;

const BRIDGE_META_FUNCTION =
  "function(){return {version:this.version,frameEpoch:this.frameEpoch};}";

let objectGroupSequence = 0;

function nextObjectGroup(tabId: number): string {
  objectGroupSequence += 1;
  return "browser-agent-next-strict-action:t" + tabId + ":" + objectGroupSequence;
}

let keyTokenSequence = 0;

function nextKeyToken(): string {
  keyTokenSequence += 1;
  return (
    "k" +
    keyTokenSequence +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

/** 页面函数运行之前的失败：页面尚未被触碰，安全。 */
function beforeAction(message: string): BrowserRuntimeError {
  return new BrowserRuntimeError("TARGET_IDENTITY_MISMATCH", message);
}

/** 页面代码可能已经运行：禁止自动重试（不变量 145）。 */
function outcomeUnknown(
  kind: StrictIsolatedActionArgs["kind"],
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "ACTION_OUTCOME_UNKNOWN",
    "strict " + kind + " " + message + "; input may already have affected the page, automatic retry is forbidden",
  );
}

interface RejectionMapping {
  code: RuntimeErrorCode;
  message: string;
  /** 为 true 时 details 带 reason，便于调用方区分同一错误码下的不同原因。 */
  withReason?: boolean;
}

/**
 * 页面函数在任何页面代码运行之前返回的拒绝原因 → 错误码。
 * 消息为固定文本，不含参数（不变量 144）。
 */
const REJECTIONS: Record<string, RejectionMapping> = {
  missing: {
    code: "TARGET_IDENTITY_MISMATCH",
    message: "target no longer resolves to a connected element",
  },
  sensitive: {
    code: "POLICY_BLOCKED",
    message: "is not allowed on credential or payment fields",
  },
  unsupported: {
    code: "ACTION_NOT_SUPPORTED",
    message: "does not support this target",
  },
  "option-not-found": {
    code: "TARGET_CAPABILITY_MISSING",
    message: "found no selectable option with the requested label",
    withReason: true,
  },
  "option-ambiguous": {
    code: "TARGET_CAPABILITY_MISSING",
    message: "found more than one selectable option with the requested label",
    withReason: true,
  },
  "not-own-form": {
    code: "ACTION_NOT_SUPPORTED",
    message: "requires a field inside the form it submits",
    withReason: true,
  },
  "no-implicit-submission": {
    code: "ACTION_NOT_SUPPORTED",
    message: "is only for forms that pressing Enter in this single field would submit",
    withReason: true,
  },
  "has-submit-button": {
    code: "ACTION_NOT_SUPPORTED",
    message: "is only for forms without a submit button; click the submit button instead",
    withReason: true,
  },
  "custom-control": {
    code: "ACTION_NOT_SUPPORTED",
    message: "cannot validate forms containing custom form controls",
    withReason: true,
  },
  "form-invalid": {
    code: "NO_EFFECT",
    message: "was not attempted because the form has invalid fields",
    withReason: true,
  },
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function rejectionError(
  kind: StrictIsolatedActionArgs["kind"],
  result: Record<string, unknown>,
  allowed: readonly string[],
): BrowserRuntimeError {
  const reason = typeof result.reason === "string" ? result.reason : undefined;
  const mapping = reason !== undefined && allowed.includes(reason)
    ? REJECTIONS[reason]
    : undefined;
  if (!mapping) {
    return outcomeUnknown(kind, "returned an unexpected result");
  }
  return new BrowserRuntimeError(
    mapping.code,
    "strict " + kind + " " + mapping.message,
    mapping.withReason ? { reason } : undefined,
  );
}

/** setValue 页面函数返回值 → 执行结果或错误码（docs/STRICT-WRITE-ACTIONS.md「结果映射」）。 */
export function interpretWriteResult(value: unknown): StrictIsolatedActionResult {
  const result = recordOf(value);

  switch (result?.status) {
    case "rejected":
      throw rejectionError("setValue", result, ["missing", "sensitive", "unsupported"]);
    case "focus-lost":
      throw outcomeUnknown("setValue", "lost focus to another element after focusing the target");
    case "changed-during-focus":
      throw outcomeUnknown("setValue", "target field changed while it was being focused");
    case "written":
      if (
        typeof result.accepted === "boolean" &&
        typeof result.valueMatched === "boolean"
      ) {
        if (!result.accepted) {
          throw outcomeUnknown("setValue", "edit command was rejected by the browser");
        }
        return { valueMatched: result.valueMatched };
      }
      break;
  }

  throw outcomeUnknown("setValue", "returned an unexpected result");
}

/** selectOption 页面函数返回值 → 执行结果或错误码。 */
export function interpretSelectResult(value: unknown): StrictIsolatedActionResult {
  const result = recordOf(value);
  if (result?.status === "rejected") {
    throw rejectionError("selectOption", result, [
      "missing",
      "sensitive",
      "unsupported",
      "option-not-found",
      "option-ambiguous",
    ]);
  }
  if (result?.status === "written" && typeof result.valueMatched === "boolean") {
    return { valueMatched: result.valueMatched };
  }
  throw outcomeUnknown("selectOption", "returned an unexpected result");
}

/** submit 页面函数返回值 → 执行结果或错误码。 */
export function interpretSubmitResult(value: unknown): StrictIsolatedActionResult {
  const result = recordOf(value);
  if (result?.status === "rejected") {
    throw rejectionError("submit", result, [
      "missing",
      "unsupported",
      "not-own-form",
      "has-submit-button",
      "no-implicit-submission",
      "custom-control",
      "form-invalid",
    ]);
  }
  if (result?.status === "submitted") return {};
  if (result?.status === "not-observed") {
    throw outcomeUnknown("submit", "did not observe a trusted submit event");
  }
  throw outcomeUnknown("submit", "returned an unexpected result");
}

/** pressKey 调用 A 的返回值：只有 armed 才继续派发按键。 */
export function interpretKeyArmResult(value: unknown): void {
  const result = recordOf(value);
  switch (result?.status) {
    case "armed":
      return;
    case "rejected":
      throw rejectionError("pressKey", result, ["missing", "sensitive", "unsupported"]);
    case "focus-lost":
      throw outcomeUnknown("pressKey", "lost focus to another element after focusing the target");
    case "changed-during-focus":
      throw outcomeUnknown("pressKey", "target changed while it was being focused");
  }
  throw outcomeUnknown("pressKey", "returned an unexpected result");
}

/** pressKey 调用 B 的返回值：只有恰好一个落在目标上的可信 keydown 才算成功。 */
export function interpretKeyReadResult(value: unknown): StrictIsolatedActionResult {
  if (recordOf(value)?.status === "pressed") return {};
  throw outcomeUnknown("pressKey", "could not prove the key reached the target");
}

/**
 * 在扩展 isolated world 中执行除 click 以外的 strict 动作。
 *
 * 只使用目标帧中唯一的、属于本扩展的 isolated world（不变量 140）：页面函数一旦在某个
 * 上下文运行过，就不能再换一个上下文重试。同一 tab 的动作串行执行，避免两个 pressKey
 * 的监听器互相记录对方的按键。结果与错误都不包含参数（不变量 144）。
 */
export class IsolatedWorldStrictActionRunner implements StrictIsolatedActionRunner {
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(
    private readonly transport: StrictIsolatedActionTransport,
    private readonly extensionOrigin: string,
  ) {}

  run(
    target: StrictIsolatedActionTarget,
    args: StrictIsolatedActionArgs,
  ): Promise<StrictIsolatedActionResult> {
    const previous = this.queues.get(target.tabId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.runExclusive(target, args));
    const settled = current.catch(() => undefined);
    this.queues.set(target.tabId, settled);
    void settled.then(() => {
      if (this.queues.get(target.tabId) === settled) {
        this.queues.delete(target.tabId);
      }
    });
    return current;
  }

  private async runExclusive(
    target: StrictIsolatedActionTarget,
    args: StrictIsolatedActionArgs,
  ): Promise<StrictIsolatedActionResult> {
    await this.transport.attach(target.tabId);

    const contexts = this.transport
      .contextsForFrame(target.tabId, target.cdpFrameId)
      .filter(
        (context) =>
          context.auxData?.type === "isolated" &&
          context.origin === this.extensionOrigin,
      );

    if (contexts.length !== 1) {
      throw beforeAction(
        "strict " + args.kind + " requires exactly one extension isolated world in the target frame",
      );
    }
    const context = contexts[0]!;
    const objectGroup = nextObjectGroup(target.tabId);

    try {
      const bridgeObjectId = await this.bridgeObjectId(
        target,
        args.kind,
        context.id,
        objectGroup,
      );
      const call = (
        functionDeclaration: string,
        values: unknown[],
      ): Promise<unknown> =>
        this.callPageFunction(
          target.tabId,
          args.kind,
          bridgeObjectId,
          objectGroup,
          functionDeclaration,
          values,
        );

      switch (args.kind) {
        case "setValue":
          return interpretWriteResult(
            await call(STRICT_SET_VALUE_FUNCTION, [target.stableId, args.value]),
          );
        case "selectOption":
          return interpretSelectResult(
            await call(STRICT_SELECT_OPTION_FUNCTION, [target.stableId, args.label]),
          );
        case "submit":
          return interpretSubmitResult(
            await call(STRICT_SUBMIT_FUNCTION, [target.stableId]),
          );
        case "pressKey":
          return await this.pressKey(target, args.key, call);
        default: {
          const unknownKind: never = args;
          throw beforeAction("strict action kind is not supported: " + String(unknownKind));
        }
      }
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

  /** A（布防 + focus）→ CDP 按键 → B（读取记录）；A 之后的任何失败都是 outcome unknown。 */
  private async pressKey(
    target: StrictIsolatedActionTarget,
    key: StrictKey,
    call: (functionDeclaration: string, values: unknown[]) => Promise<unknown>,
  ): Promise<StrictIsolatedActionResult> {
    const token = nextKeyToken();
    interpretKeyArmResult(
      await call(STRICT_KEY_ARM_FUNCTION, [target.stableId, key, token]),
    );

    const definition = KEY_DEFINITIONS[key];
    try {
      for (const type of ["keyDown", "keyUp"] as const) {
        await this.transport.send(target.tabId, "Input.dispatchKeyEvent", {
          type,
          key,
          code: definition.code,
          windowsVirtualKeyCode: definition.keyCode,
          nativeVirtualKeyCode: definition.keyCode,
        });
      }
    } catch {
      throw outcomeUnknown("pressKey", "key dispatch failed after it may have been delivered");
    }

    return interpretKeyReadResult(
      await call(STRICT_KEY_READ_FUNCTION, [token]),
    );
  }

  /** 调用页面函数；调用一旦发出，失败或页面异常都是 outcome unknown。 */
  private async callPageFunction(
    tabId: number,
    kind: StrictIsolatedActionArgs["kind"],
    objectId: string,
    objectGroup: string,
    functionDeclaration: string,
    values: unknown[],
  ): Promise<unknown> {
    let result: RuntimeCallResult;
    try {
      result = await this.transport.send<RuntimeCallResult>(
        tabId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration,
          arguments: values.map((value) => ({ value })),
          objectGroup,
          returnByValue: true,
          silent: true,
        },
      );
    } catch {
      throw outcomeUnknown(kind, "call failed after it may have been dispatched");
    }

    if (result.exceptionDetails) {
      throw outcomeUnknown(kind, "threw inside the page");
    }

    return result.result.value;
  }

  private async bridgeObjectId(
    target: StrictIsolatedActionTarget,
    kind: StrictIsolatedActionArgs["kind"],
    contextId: number,
    objectGroup: string,
  ): Promise<string> {
    try {
      const bridge = await this.transport.send<RuntimeCallResult>(
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
        throw beforeAction("strict " + kind + " identity bridge is unavailable");
      }

      const meta = await this.transport.send<RuntimeCallResult>(
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
        throw beforeAction(
          "strict " + kind + " identity bridge does not match the observed frame",
        );
      }

      return objectId;
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw beforeAction("strict " + kind + " could not reach the identity bridge");
    }
  }
}
