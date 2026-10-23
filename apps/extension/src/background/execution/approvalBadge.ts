import type {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

export interface ApprovalBadgeActionApi {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
}

export type ApprovalBadgeSource = Pick<
  OperatorApprovalStore,
  "subscribe" | "listPending" | "nextExpiryAt"
>;

export interface ApprovalBadgeOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const APPROVAL_BADGE_COLOR = "#d93025";
export const APPROVAL_BADGE_TITLE = "Browser Agent 审批";

// 到期后留一点余量再清理，避免恰好在 expiresAt 前触发。
const EXPIRY_SLACK_MS = 50;
// 定时器最短间隔：防止时钟异常时形成忙循环。
const MIN_TIMER_DELAY_MS = 250;

/** chrome.action 调用失败只影响提示，不能影响审批流程。 */
function ignoreFailure(call: () => Promise<void>): void {
  try {
    void call().catch(() => undefined);
  } catch {
    // 同步抛错同样忽略。
  }
}

/**
 * 用扩展图标角标显示待审批数（全局计数，只含数字）。
 *
 * store 的过期是惰性的：这里按最早到期时间调度定时器，到点无条件调用
 * listPending() 触发清理并重新调度，不依赖 change 事件是否发生。
 * service worker 启动时先渲染一次，清掉上次进程残留的角标。
 */
export function bindOperatorApprovalBadge(
  action: ApprovalBadgeActionApi,
  approvals: ApprovalBadgeSource,
  options: ApprovalBadgeOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let disposed = false;

  function render(count: number): void {
    ignoreFailure(() =>
      action.setBadgeText({
        text: count > 0 ? String(count) : "",
      })
    );
    ignoreFailure(() =>
      action.setTitle({
        title: count > 0
          ? APPROVAL_BADGE_TITLE + "（" + count + " 个待处理）"
          : APPROVAL_BADGE_TITLE,
      })
    );
  }

  function schedule(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (disposed) {
      return;
    }

    const next = approvals.nextExpiryAt();
    if (next === undefined) {
      return;
    }

    timer = setTimer(
      () => {
        timer = undefined;
        if (disposed) {
          return;
        }
        approvals.listPending();
        schedule();
      },
      Math.max(
        MIN_TIMER_DELAY_MS,
        next - now() + EXPIRY_SLACK_MS,
      ),
    );
  }

  const unsubscribe = approvals.subscribe((count) => {
    if (disposed) {
      return;
    }
    render(count);
    schedule();
  });

  ignoreFailure(() =>
    action.setBadgeBackgroundColor({
      color: APPROVAL_BADGE_COLOR,
    })
  );
  render(approvals.listPending().length);
  schedule();

  return () => {
    disposed = true;
    unsubscribe();
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };
}
