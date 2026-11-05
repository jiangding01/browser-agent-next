import {
  BrowserRuntimeError,
  isStrictValueAllowed,
} from "@browser-agent-next/core";
import { exactKey } from "./nameMatch.js";

/**
 * 调用方事先描述的一步（docs/DETERMINISTIC-ROUTER.md「StepIntent」）。
 *
 * 只描述“点哪个元素”，不含 ref：多步计划与 recipe 回放时 ref 在描述时还不存在。
 */
export interface StepIntent {
  operation: "click";
  target: {
    /** 与元素 accessible name 的 exactKey 相等（区分大小写）。 */
    name: string;
    /** 与 semantic.role 精确相等。 */
    role?: string;
    /** 元素所在 frame 的有效 origin 必须精确等于它；缺省为 observation.tab.origin。 */
    frameOrigin?: string;
  };
}

/**
 * 低于 DOM 源的名称截断长度 240，被截断的元素名不会与 intent 精确相等；
 * NFKC 会缩短名称，因此 router 另外排除原文 ≥ 240 码元的元素。
 */
export const STEP_INTENT_NAME_MAX_LENGTH = 200;

const ROLE_PATTERN = /^[a-z][a-z-]{0,63}$/;

function invalid(): never {
  throw new BrowserRuntimeError("POLICY_BLOCKED", "invalid step intent");
}

/** 只接受普通对象：原型上的属性（含被污染的 Object.prototype）不得被当作字段读取。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 按全部自有 key（含不可枚举与 symbol）做 exact-key 校验。 */
function keysWithin(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)),
    )
  );
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function isExactWebOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
}

/**
 * StepIntent 的唯一入口：exact-key、已知 operation、可见文本名称、合法 role 与 origin。
 * 失败一律 POLICY_BLOCKED，消息为固定文本、不含输入内容。返回新对象，不保留输入引用。
 */
export function parseStepIntent(value: unknown): StepIntent {
  if (!isPlainRecord(value) || !keysWithin(value, ["operation", "target"], [])) {
    invalid();
  }
  if (own(value, "operation") !== "click") invalid();

  const target = own(value, "target");
  if (!isPlainRecord(target) || !keysWithin(target, ["name"], ["role", "frameOrigin"])) {
    invalid();
  }

  // 每个字段只读一次，校验与返回使用同一个值（防 getter 两次读取结果不同）。
  const name = own(target, "name");
  const role = own(target, "role");
  const frameOrigin = own(target, "frameOrigin");
  if (
    typeof name !== "string" ||
    name.length > STEP_INTENT_NAME_MAX_LENGTH ||
    !isStrictValueAllowed(name)
  ) {
    invalid();
  }
  const key = exactKey(name);
  if (key.length === 0 || key.length > STEP_INTENT_NAME_MAX_LENGTH) invalid();

  if (role !== undefined && (typeof role !== "string" || !ROLE_PATTERN.test(role))) {
    invalid();
  }
  if (
    frameOrigin !== undefined &&
    (typeof frameOrigin !== "string" || !isExactWebOrigin(frameOrigin))
  ) {
    invalid();
  }

  return {
    operation: "click",
    target: {
      name,
      ...(role !== undefined ? { role } : {}),
      ...(frameOrigin !== undefined ? { frameOrigin } : {}),
    },
  };
}
