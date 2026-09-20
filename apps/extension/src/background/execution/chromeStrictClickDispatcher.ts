import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";

export interface StrictClickCdpTransport {
  send<T>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

export type StrictClickDispatchPhase =
  | "before-input"
  | "mouse-moved"
  | "mouse-pressed"
  | "mouse-released";

export class StrictClickDispatchError extends Error {
  readonly phase: StrictClickDispatchPhase;
  readonly outcomeMayHaveChanged: boolean;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: {
      phase: StrictClickDispatchPhase;
      outcomeMayHaveChanged: boolean;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = "StrictClickDispatchError";
    this.phase = options.phase;
    this.outcomeMayHaveChanged = options.outcomeMayHaveChanged;
    this.cause = options.cause;
  }
}

/**
 * 最小化真实 mouse dispatch primitive。
 *
 * 一旦 mousePressed 成功，就不能再把后续失败当成“安全重试”：
 * 页面可能已经收到 pointer/mouse down handler，甚至在 release 丢失前发生副作用。
 */
export class ChromeStrictClickDispatcher {
  constructor(
    private readonly cdp: StrictClickCdpTransport,
  ) {}

  async dispatch(
    prepared: PreparedStrictClickTarget,
  ): Promise<void> {
    const { x, y } = prepared.point;

    if (
      prepared.coordinateSpace !==
        "top-level-viewport" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new StrictClickDispatchError(
        "strict click point or coordinate space is invalid",
        {
          phase: "before-input",
          outcomeMayHaveChanged: false,
          cause: undefined,
        },
      );
    }

    try {
      await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
    } catch (cause) {
      throw new StrictClickDispatchError(
        "strict click failed before mouse press",
        {
          phase: "before-input",
          outcomeMayHaveChanged: false,
          cause,
        },
      );
    }

    try {
      await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } catch (cause) {
      throw new StrictClickDispatchError(
        "strict click mouse press failed",
        {
          phase: "mouse-moved",
          outcomeMayHaveChanged: false,
          cause,
        },
      );
    }

    try {
      await this.cdp.send(prepared.tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } catch (cause) {
      throw new StrictClickDispatchError(
        "strict click mouse release failed after press",
        {
          phase: "mouse-pressed",
          outcomeMayHaveChanged: true,
          cause,
        },
      );
    }
  }
}
