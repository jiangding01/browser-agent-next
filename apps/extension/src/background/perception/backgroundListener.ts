import {
  isObserveTabRequest,
  type ObserveTabResponse,
} from "../../protocol/perception.js";
import type {
  BackgroundMessageSender,
  ExtensionBackgroundRuntimeApi,
} from "../runtimeApi.js";
import type { ChromeDomObservationService } from "../chrome/chromeObservationService.js";
import type { TabOwnershipRegistry } from "@browser-agent-next/runtime";

export type BackgroundRuntimeApi = ExtensionBackgroundRuntimeApi;

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "tab perception failed";
  return message.slice(0, 500);
}

export function registerObserveTabBackgroundListener(
  runtime: BackgroundRuntimeApi,
  service: ChromeDomObservationService,
  ownership?: TabOwnershipRegistry,
): () => void {
  const listener = (
    message: unknown,
    sender: BackgroundMessageSender,
    sendResponse: (response: ObserveTabResponse) => void,
  ): boolean | void => {
    if (sender.id !== runtime.id) return;
    if (!isObserveTabRequest(message)) return;

    void service.observe({
      tabId: message.tabId,
      // 普通 runtime message 无权声明 ownership。只有 Runtime 自己通过
      // browser.open 记录在 registry 中的 Tab 才能获得 Agent-owned 语义。
      ownedBySession:
        ownership?.isOwned(message.tabId) ?? false,
      ...(message.sinceRevision !== undefined
        ? { sinceRevision: message.sinceRevision }
        : {}),
      ...(message.options !== undefined
        ? { options: message.options }
        : {}),
    }).then(
      (observation) => {
        sendResponse({
          type: "perception.observe-tab.result",
          requestId: message.requestId,
          ok: true,
          observation,
        });
      },
      (error: unknown) => {
        sendResponse({
          type: "perception.observe-tab.result",
          requestId: message.requestId,
          ok: false,
          error: {
            code: "TAB_PERCEPTION_FAILED",
            message: boundedError(error),
          },
        });
      },
    );

    return true;
  };

  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}
