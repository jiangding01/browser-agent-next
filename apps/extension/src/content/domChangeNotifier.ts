import type { DomFramePerceptionSource } from "./domFrameSource.js";
import type { ContentRuntimeApi } from "./perceptionListener.js";

export interface DomChangedMessage {
  type: "perception.dom-changed";
  frameEpoch: string;
  sequence: number;
}

/**
 * 只发送“发生过变化”的无内容 signal。
 *
 * 不发送 DOM 文本、属性值、selector 或用户输入。MutationObserver 只用于
 * browser.wait 的提前唤醒；真正状态仍必须重新走 BrowserObservation。
 */
export function installDomChangeNotifier(
  runtime: ContentRuntimeApi,
  document: Document,
  source: DomFramePerceptionSource,
  options: {
    debounceMs?: number;
  } = {},
): () => void {
  if (!runtime.sendMessage) {
    return () => {};
  }

  const debounceMs = options.debounceMs ?? 50;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const emit = (): void => {
    timer = undefined;
    if (stopped) return;

    sequence += 1;
    void runtime.sendMessage?.({
      type: "perception.dom-changed",
      frameEpoch: source.frameEpoch,
      sequence,
    } satisfies DomChangedMessage).catch(() => {
      // Service worker 暂不可用时只损失一次提前唤醒。
      // wait 仍有 bounded timeout fallback，不影响 correctness。
    });
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(emit, debounceMs);
  };

  const observer = new MutationObserver(schedule);
  const root = document.documentElement;

  if (root) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }

  return () => {
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
