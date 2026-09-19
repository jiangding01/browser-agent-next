import type { DomFramePerceptionSource } from "./domFrameSource.js";

export const DOM_IDENTITY_BRIDGE_KEY =
  "__BROWSER_AGENT_NEXT_IDENTITY_BRIDGE_V1__";

export interface DomIdentityBridge {
  readonly version: 1;
  readonly frameEpoch: string;
  stableIdOf(element: Element): string | null;
  resolve(stableId: string): Element | null;
}

/**
 * 安装在 Extension content-script isolated world 中的最小身份桥。
 *
 * 它不会向页面 DOM 写 attribute，也不会暴露到页面 main world。CDP 只能通过
 * 我们自己的 isolated-world execution context 调用固定 bridge method，从而把
 * content stableId 与 backendDOMNodeId 精确关联。
 */
export function installDomIdentityBridge(
  target: typeof globalThis,
  source: DomFramePerceptionSource,
): DomIdentityBridge {
  const bridge: DomIdentityBridge = Object.freeze({
    version: 1,
    frameEpoch: source.frameEpoch,

    stableIdOf(element: Element): string | null {
      return source.stableIdOf(element) ?? null;
    },

    resolve(stableId: string): Element | null {
      return source.resolveStableId(stableId) ?? null;
    },
  });

  Object.defineProperty(target, DOM_IDENTITY_BRIDGE_KEY, {
    value: bridge,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return bridge;
}
