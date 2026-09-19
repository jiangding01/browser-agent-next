import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";

export interface StrictClickCdpTransport {
  send<T>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

/**
 * 最小化的真实 mouse dispatch primitive。
 *
 * 本类不做 policy，也不能独立暴露给 Agent。只有上层在：
 *
 * 1. stored observation strict prepare；
 * 2. trusted authorization / effect policy；
 * 3. commit 前二次 prepare；
 *
 * 全部通过后才能调用。
 */
export class ChromeStrictClickDispatcher {
  constructor(
    private readonly cdp: StrictClickCdpTransport,
  ) {}

  async dispatch(
    prepared: PreparedStrictClickTarget,
  ): Promise<void> {
    const { x, y } = prepared.point;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("strict click point is invalid");
    }

    await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });

    await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });

    await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
}
