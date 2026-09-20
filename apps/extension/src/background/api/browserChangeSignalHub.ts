import type {
  BackgroundMessageSender,
  ExtensionBackgroundRuntimeApi,
} from "../runtimeApi.js";
import type { ChromeLifecycleApi } from "../chrome/chromeLifecycleBinding.js";

interface PendingWaiter {
  afterVersion: number;
  resolve(changed: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

function isDomChangedMessage(
  value: unknown,
): value is {
  type: "perception.dom-changed";
  frameEpoch: string;
  sequence: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    candidate.type === "perception.dom-changed" &&
    typeof candidate.frameEpoch === "string" &&
    candidate.frameEpoch.length > 0 &&
    candidate.frameEpoch.length <= 128 &&
    typeof candidate.sequence === "number" &&
    Number.isInteger(candidate.sequence) &&
    candidate.sequence > 0
  );
}

/**
 * Event-assisted wait hub。
 *
 * signal 只是 pacing/wakeup hint，不是 correctness proof。
 * 收到 signal 后必须重新 Observe + Verify。
 */
export class BrowserChangeSignalHub {
  private readonly versions = new Map<number, number>();
  private readonly waiters = new Map<number, Set<PendingWaiter>>();

  version(tabId: number): number {
    return this.versions.get(tabId) ?? 0;
  }

  notify(tabId: number): number {
    const next = this.version(tabId) + 1;
    this.versions.set(tabId, next);

    const tabWaiters = this.waiters.get(tabId);
    if (!tabWaiters) return next;

    for (const waiter of [...tabWaiters]) {
      if (next <= waiter.afterVersion) continue;
      clearTimeout(waiter.timer);
      tabWaiters.delete(waiter);
      waiter.resolve(true);
    }

    if (tabWaiters.size === 0) {
      this.waiters.delete(tabId);
    }

    return next;
  }

  async waitForChange(
    tabId: number,
    afterVersion: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.version(tabId) > afterVersion) {
      return true;
    }

    if (timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      const waiter: PendingWaiter = {
        afterVersion,
        resolve,
        timer: setTimeout(() => {
          const tabWaiters = this.waiters.get(tabId);
          tabWaiters?.delete(waiter);
          if (tabWaiters?.size === 0) {
            this.waiters.delete(tabId);
          }
          resolve(false);
        }, timeoutMs),
      };

      let tabWaiters = this.waiters.get(tabId);
      if (!tabWaiters) {
        tabWaiters = new Set();
        this.waiters.set(tabId, tabWaiters);
      }
      tabWaiters.add(waiter);

      // 注册 waiter 后再做一次版本检查，关闭 check→subscribe race。
      if (this.version(tabId) > afterVersion) {
        clearTimeout(waiter.timer);
        tabWaiters.delete(waiter);
        if (tabWaiters.size === 0) {
          this.waiters.delete(tabId);
        }
        resolve(true);
      }
    });
  }

  clearTab(tabId: number): void {
    this.versions.delete(tabId);

    const tabWaiters = this.waiters.get(tabId);
    if (!tabWaiters) return;

    for (const waiter of tabWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.waiters.delete(tabId);
  }
}

export function registerBrowserChangeSignals(
  runtime: ExtensionBackgroundRuntimeApi,
  chromeApi: ChromeLifecycleApi,
  hub: BrowserChangeSignalHub,
): () => void {
  const onMessage = (
    message: unknown,
    sender: BackgroundMessageSender,
  ): void => {
    if (sender.id !== runtime.id) return;
    if (!isDomChangedMessage(message)) return;

    const tabId = sender.tab?.id;
    if (
      typeof tabId !== "number" ||
      !Number.isInteger(tabId) ||
      tabId < 0
    ) {
      return;
    }

    hub.notify(tabId);
  };

  const onCommitted = (details: {
    tabId: number;
    frameId: number;
    documentId: string;
  }): void => {
    hub.notify(details.tabId);
  };

  runtime.onMessage.addListener(onMessage);
  chromeApi.webNavigation.onCommitted.addListener(onCommitted);

  return () => {
    runtime.onMessage.removeListener(onMessage);
    chromeApi.webNavigation.onCommitted.removeListener(onCommitted);
  };
}
