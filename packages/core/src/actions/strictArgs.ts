import { BrowserRuntimeError } from "../errors/codes.js";

/**
 * Strict 动作的参数（docs/STRICT-WRITE-ACTIONS.md）。
 *
 * grant 精确绑定 canonicalStrictActionArgs 的结果：为一个值签发的授权
 * 不能用于输入另一个值（不变量 138）。
 */
export type StrictActionArgs =
  | { kind: "click" }
  | { kind: "setValue"; value: string }
  | { kind: "selectOption"; label: string }
  | { kind: "submit" }
  | { kind: "pressKey"; key: StrictKey };

/** pressKey 只接受不带提交语义的按键（不变量 149）。 */
export const STRICT_KEYS = ["Escape", "Tab", "ArrowUp", "ArrowDown"] as const;

export type StrictKey = (typeof STRICT_KEYS)[number];

export function isStrictKey(value: unknown): value is StrictKey {
  return (
    typeof value === "string" &&
    (STRICT_KEYS as readonly string[]).includes(value)
  );
}

export type StrictActionKind = StrictActionArgs["kind"];

/** 单行表单值的上限（UTF-16 单元）；同时保证审批页能完整显示。 */
export const STRICT_VALUE_MAX_LENGTH = 1_024;

/**
 * 审批页必须显示将要输入的全部内容（不变量 142），因此拒绝：
 * 控制字符（含换行与制表符）、格式字符与所有默认可忽略字符（零宽、bidi、
 * 变体选择符、Hangul filler 等）、行 / 段分隔符、除 U+0020 以外的空格分隔符，
 * 以及常见字体中渲染为空白的 U+2800（Braille Pattern Blank）。
 */
const FORBIDDEN_VALUE_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2800]/u;

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function blocked(message: string): never {
  throw new BrowserRuntimeError("POLICY_BLOCKED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

/** 单行写入值是否满足字符集与长度规则。 */
export function isStrictValueAllowed(value: string): boolean {
  return (
    value.length <= STRICT_VALUE_MAX_LENGTH &&
    !FORBIDDEN_VALUE_CHARACTER.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

/**
 * 所有入口共用的参数校验：exact-key、已知 kind、值的长度与字符集。
 * 失败一律 POLICY_BLOCKED，消息为固定文本、不包含值本身。
 */
export function parseStrictActionArgs(value: unknown): StrictActionArgs {
  if (!isRecord(value)) {
    blocked("strict action must be an object");
  }

  switch (value.kind) {
    case "click":
      if (!hasExactKeys(value, ["kind"])) {
        blocked("strict click action has unexpected fields");
      }
      return { kind: "click" };

    case "setValue":
      if (!hasExactKeys(value, ["kind", "value"])) {
        blocked("strict setValue action must have exactly kind and value");
      }
      if (typeof value.value !== "string") {
        blocked("strict setValue value must be a string");
      }
      if (!isStrictValueAllowed(value.value)) {
        blocked(
          "strict setValue value is too long or contains characters that cannot be displayed for approval",
        );
      }
      return { kind: "setValue", value: value.value };

    case "selectOption":
      if (!hasExactKeys(value, ["kind", "label"])) {
        blocked("strict selectOption action must have exactly kind and label");
      }
      if (typeof value.label !== "string" || value.label === "") {
        blocked("strict selectOption label must be a non-empty string");
      }
      if (!isStrictValueAllowed(value.label)) {
        blocked(
          "strict selectOption label is too long or contains characters that cannot be displayed for approval",
        );
      }
      return { kind: "selectOption", label: value.label };

    case "submit":
      if (!hasExactKeys(value, ["kind"])) {
        blocked("strict submit action has unexpected fields");
      }
      return { kind: "submit" };

    case "pressKey":
      if (!hasExactKeys(value, ["kind", "key"])) {
        blocked("strict pressKey action must have exactly kind and key");
      }
      if (!isStrictKey(value.key)) {
        blocked("strict pressKey key is not supported");
      }
      return { kind: "pressKey", key: value.key };

    default:
      return blocked("strict action kind is not supported");
  }
}

/**
 * 从 `browser.act` 的 action（`kind` 加可选的 `value` / `label` / `key`）组装 strict 参数。
 * 只取这三个参数字段，交给 parseStrictActionArgs 做 exact-key 校验：
 * click 带 label、selectOption 带 value 之类的组合都会被拒绝。
 */
export function strictArgsFromActAction(action: {
  kind: unknown;
  value?: unknown;
  label?: unknown;
  key?: unknown;
}): StrictActionArgs {
  const candidate: Record<string, unknown> = { kind: action.kind };
  if (action.value !== undefined) candidate.value = action.value;
  if (action.label !== undefined) candidate.label = action.label;
  if (action.key !== undefined) candidate.key = action.key;
  return parseStrictActionArgs(candidate);
}

/** 确定的规范化字符串：固定字段顺序，用于 grant 精确匹配。 */
export function canonicalStrictActionArgs(args: StrictActionArgs): string {
  switch (args.kind) {
    case "click":
      return JSON.stringify({ kind: "click" });
    case "setValue":
      return JSON.stringify({ kind: "setValue", value: args.value });
    case "selectOption":
      return JSON.stringify({ kind: "selectOption", label: args.label });
    case "submit":
      return JSON.stringify({ kind: "submit" });
    case "pressKey":
      return JSON.stringify({ kind: "pressKey", key: args.key });
  }
}
