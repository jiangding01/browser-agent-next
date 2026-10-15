import type { StrictClickCdpTransport } from "./chromeStrictClickDispatcher.js";
import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";

/**
 * Root renderer presentation fence。
 *
 * 浏览器把 `Input.dispatchMouseEvent` 路由到哪个 frame process，依据的是
 * root renderer 最近一次提交给 compositor 的 hit-test 数据；Strict prepare 的
 * `DOM.getBoxModel` / `elementFromPoint` 读取的却是 main-thread 的实时 layout。
 * scroll、layout shift 或 transform 尚未被 present 时，两者会分叉：prepare 证明
 * 命中 OOPIF owner，真实输入却被路由到 root frame 或另一个 process。
 *
 * 后台（非 active）Tab 的 root renderer 在 Linux Chromium 上可能被节流到约
 * 1 fps，因此这个窗口可以长达秒级。fence 在 root frame 的独立 isolated world
 * 中等待若干个 animation frame，证明 root renderer 已经在这之后提交了新的
 * compositor frame；超时或任何异常都在任何 input 之前 fail closed。
 * 文档为 hidden 时浏览器不会 present frame，fence 立即 fail closed。
 *
 * 当前只覆盖 root renderer：nested OOPIF 中间层 renderer 的 presentation
 * 延迟尚未单独 fence（见 docs/CHILD-FRAME.md）。
 */

export const PRESENTATION_FENCE_WORLD_NAME =
  "browser-agent-next-presentation-fence";

// 两个 rAF 只能证明 main frame N 已 commit；第三个 rAF 给 frame N 的
// activation/draw（hit-test 数据提交）留出完整的一帧。
export const DEFAULT_PRESENTATION_FENCE_FRAMES = 3;

export const DEFAULT_PRESENTATION_FENCE_TIMEOUT_MS = 5_000;

// host 侧额外等待：renderer 冻结时页面内 setTimeout 也可能不触发。
const HOST_TIMEOUT_GRACE_MS = 1_000;

export type PresentationFenceResult =
  | {
      ok: true;
      frames: number;
    }
  | {
      ok: false;
      reason: string;
    };

export interface StrictClickPresentationFence {
  /**
   * 目标位于 OOPIF child session 时，浏览器必须按已 present 的 hit-test 数据
   * 跨 process 路由输入，因此需要 fence。main-frame / 同 process child frame
   * 的输入由 root renderer 用实时 layout 做 hit-test，不需要 fence。
   */
  required(prepared: PreparedStrictClickTarget): boolean;

  waitForPresentedFrames(
    tabId: number,
  ): Promise<PresentationFenceResult>;
}

export interface PresentationFenceOptions {
  frames?: number;
  timeoutMs?: number;
}

interface FrameTreeResult {
  frameTree?: {
    frame?: {
      id?: unknown;
    };
  };
}

interface CreateIsolatedWorldResult {
  executionContextId?: unknown;
}

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: unknown;
}

function boundedReason(
  error: unknown,
): string {
  return (
    error instanceof Error
      ? error.message
      : "presentation fence failed"
  ).slice(0, 300);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return value !== undefined &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= max
    ? value
    : fallback;
}

/**
 * 在 isolated world 中执行，页面不能替换这里使用的 requestAnimationFrame。
 */
export function presentationFenceExpression(
  frames: number,
  timeoutMs: number,
): string {
  return (
    "new Promise((resolve) => {" +
    "let count = 0;" +
    "if (document.visibilityState === 'hidden') { resolve({presented: false, hidden: true, frames: 0}); return; }" +
    "const timer = setTimeout(() => resolve({presented: false, frames: count}), " +
    String(timeoutMs) +
    ");" +
    "const step = () => {" +
    "count += 1;" +
    "if (count >= " +
    String(frames) +
    ") { clearTimeout(timer); resolve({presented: true, frames: count}); return; }" +
    "requestAnimationFrame(step);" +
    "};" +
    "requestAnimationFrame(step);" +
    "})"
  );
}

export function createRootPresentationFence(
  transport: StrictClickCdpTransport,
  options: PresentationFenceOptions = {},
): StrictClickPresentationFence {
  const frames = positiveInteger(
    options.frames,
    DEFAULT_PRESENTATION_FENCE_FRAMES,
    10,
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_PRESENTATION_FENCE_TIMEOUT_MS,
    30_000,
  );

  async function evaluateFence(
    tabId: number,
  ): Promise<PresentationFenceResult> {
    const tree =
      await transport.send<FrameTreeResult>(
        tabId,
        "Page.getFrameTree",
      );
    const rootFrameId =
      tree.frameTree?.frame?.id;

    if (
      typeof rootFrameId !== "string" ||
      rootFrameId.length === 0
    ) {
      return {
        ok: false,
        reason: "root frame id is unavailable",
      };
    }

    const world =
      await transport.send<CreateIsolatedWorldResult>(
        tabId,
        "Page.createIsolatedWorld",
        {
          frameId: rootFrameId,
          worldName:
            PRESENTATION_FENCE_WORLD_NAME,
          grantUniveralAccess: false,
        },
      );
    const contextId =
      world.executionContextId;

    if (
      typeof contextId !== "number" ||
      !Number.isInteger(contextId)
    ) {
      return {
        ok: false,
        reason:
          "root isolated world is unavailable",
      };
    }

    const evaluated =
      await transport.send<RuntimeEvaluateResult>(
        tabId,
        "Runtime.evaluate",
        {
          expression:
            presentationFenceExpression(
              frames,
              timeoutMs,
            ),
          contextId,
          awaitPromise: true,
          returnByValue: true,
          silent: true,
        },
      );

    const value =
      evaluated.result?.value as
        | {
            presented?: unknown;
            hidden?: unknown;
            frames?: unknown;
          }
        | null
        | undefined;

    if (
      !evaluated.exceptionDetails &&
      value?.hidden === true
    ) {
      return {
        ok: false,
        reason:
          "root document is hidden; the browser does not present frames for it",
      };
    }

    if (
      evaluated.exceptionDetails ||
      !value ||
      value.presented !== true ||
      typeof value.frames !== "number" ||
      value.frames < frames
    ) {
      return {
        ok: false,
        reason:
          "root renderer did not present " +
          String(frames) +
          " animation frames within " +
          String(timeoutMs) +
          "ms",
      };
    }

    return {
      ok: true,
      frames: value.frames,
    };
  }

  return {
    required(prepared) {
      return prepared.cdpSessionId !== undefined;
    },

    async waitForPresentedFrames(tabId) {
      let timer:
        | ReturnType<typeof setTimeout>
        | undefined;

      const hostTimeout =
        new Promise<PresentationFenceResult>(
          (resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  ok: false,
                  reason:
                    "presentation fence timed out",
                }),
              timeoutMs +
                HOST_TIMEOUT_GRACE_MS,
            );
          },
        );

      try {
        return await Promise.race([
          evaluateFence(tabId).catch(
            (error: unknown) => ({
              ok: false as const,
              reason:
                "presentation fence failed: " +
                boundedReason(error),
            }),
          ),
          hostTimeout,
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
