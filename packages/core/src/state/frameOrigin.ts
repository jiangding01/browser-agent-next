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
  const matches = observation.frames.filter((item) => item.frameId === frameId);
  // frameId 必须唯一：重复时无法确定元素属于哪一个 frame。
  if (matches.length !== 1) return undefined;
  const frame = matches[0]!;

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

/**
 * 从目标 frame 沿 parentFrameId 走到顶层，依次返回每一层的有效 origin
 * （第一个是目标 frame，最后一个是顶层 frame）。
 *
 * act 授权要求整条链都在 allowlist 内（不变量 162）：中间层 frame 能设置子 frame 的
 * src 并控制其布局，只检查目标 frame 挡不住未放行的中间层。以下任一情况返回 undefined，
 * 调用方必须 fail closed：链上某层 origin 无法判定（含 frameId 不唯一，见 effectiveFrameOrigin）或 `accessible` 不为 true
 * （出境投影把不放行的 frame 标为不可访问并删去 origin，顶层不得因此回落到 tab origin）、
 * 父 frame 不在 observation 中、父链成环。
 */
export function frameOriginChain(
  observation: Pick<BrowserObservation, "frames" | "tab">,
  frameId: string,
): string[] | undefined {
  const frames = new Map(
    observation.frames.map((frame) => [frame.frameId, frame]),
  );
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = frames.get(frameId);

  while (current !== undefined) {
    if (seen.has(current.frameId)) return undefined;
    seen.add(current.frameId);
    if (current.accessible !== true) return undefined;

    const origin = effectiveFrameOrigin(observation, current.frameId);
    if (origin === undefined) return undefined;
    chain.push(origin);

    if (current.parentFrameId === undefined) return chain;
    current = frames.get(current.parentFrameId);
  }

  return undefined;
}

/**
 * Strict 授权的 origin 判定（不变量 162）：顶层 tab origin 与 `frameOriginChain` 的每一层
 * 都满足 `isAllowed` 时返回这条链（目标在前、顶层在后），否则返回 undefined。
 *
 * 扩展侧签发、审批入队、执行与 MCP act broker 共用这一实现，只是 allowlist 不同。
 */
export function allowedFrameOriginChain(
  observation: Pick<BrowserObservation, "frames" | "tab">,
  frameId: string,
  isAllowed: (origin: string) => boolean,
): string[] | undefined {
  if (!isAllowed(observation.tab.origin)) return undefined;
  const chain = frameOriginChain(observation, frameId);
  return chain !== undefined && chain.every((origin) => isAllowed(origin))
    ? chain
    : undefined;
}

