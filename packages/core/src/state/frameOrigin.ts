import type {
  BrowserObservation,
} from "./types.js";

/** 上报 origin 的长度上限：序列化 origin 不含 path，远小于这个值。 */
export const FRAME_ORIGIN_MAX_LENGTH = 2_048;

/**
 * 是否为可用于 origin 判定的序列化 origin：opaque 的 `"null"`，或 http / https 且解析后
 * origin 与原文完全相同的值（不含 path / query / fragment / credentials）。
 *
 * 只接受 http(s)：allowlist 只支持 http(s)；其它 scheme（file:、chrome-extension: 等）
 * 在浏览器与 Node 的 URL 实现中序列化结果不一致，一律按不合法处理，由调用方 fail closed。
 */
export function isSerializedOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > FRAME_ORIGIN_MAX_LENGTH) {
    return false;
  }
  if (value === "null") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

/** URL 对应的 http(s) origin；无法解析、opaque 或其它 scheme 时返回 undefined。 */
function originOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 元素所在 frame 用于 origin 判定的有效 origin（不变量 161）。
 *
 * 出境投影（read plane）、act broker（act plane）与 deterministic router 共用这一实现。
 * 以 frame 自报的 origin（扩展 content script 在 isolated world 读取的 `self.origin`）为准：
 * URL 看不出 about:blank 的 origin 来自导航发起方、sandbox frame 是 opaque，因此
 * - 自报为合法的 http(s) origin 时返回它；自报为 `"null"` 或不合法时返回 undefined；
 * - 子 frame 没有自报 origin（content script 未响应）时返回 undefined，不按 URL 推导、
 *   也不继承父 frame；
 * - 只有顶层 frame 在未自报时按 URL 推导（缺 url 回落到 tab origin）：顶层 URL 由浏览器
 *   提供，且顶层 DOM 快照是 observation 的必要条件，正常情况下总会自报。
 *
 * 返回 undefined 时调用方必须 fail closed。
 */
export function effectiveFrameOrigin(
  observation: Pick<BrowserObservation, "frames" | "tab">,
  frameId: string,
): string | undefined {
  const frame = observation.frames.find((item) => item.frameId === frameId);
  if (frame === undefined) return undefined;

  if (frame.origin !== undefined) {
    return isSerializedOrigin(frame.origin) && frame.origin !== "null"
      ? frame.origin
      : undefined;
  }
  if (frame.parentFrameId === undefined) {
    return originOfUrl(frame.url ?? observation.tab.origin);
  }
  return undefined;
}
