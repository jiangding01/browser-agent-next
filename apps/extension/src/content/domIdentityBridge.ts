import { DOM_IDENTITY_BRIDGE_KEY } from "../protocol/identityBridge.js";
import type { DomFramePerceptionSource } from "./domFrameSource.js";

export { DOM_IDENTITY_BRIDGE_KEY };

export interface DomIdentityBridge {
  readonly version: 1;
  readonly frameEpoch: string;
  stableIdOf(element: Element): string | null;
  resolve(stableId: string): Element | null;
}

/**
 * 安装在 Extension content-script isolated world 中的最小身份桥。
 *
 * 不向页面 DOM 写 attribute，也不暴露到页面 main world。Background 只能
 * 通过 CDP 找到本扩展的 isolated-world execution context，再调用固定方法。
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
