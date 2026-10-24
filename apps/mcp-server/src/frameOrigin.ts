import type {
  BrowserObservation,
} from "@browser-agent-next/core";

/**
 * 解析 frame 用于 origin 判定的有效 URL。
 *
 * 出境投影（read plane）与 act broker（act plane）共用这一实现，避免两处判定分叉：
 * - 顶层 frame 缺 url 时回落到 tab origin；
 * - about:blank / about:srcdoc 继承父 frame；
 * - 其余缺 url 的 frame、找不到的 frame 或父链成环都返回 undefined（调用方必须 fail closed）。
 */
export function effectiveFrameUrl(
  observation: Pick<BrowserObservation, "frames" | "tab">,
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
