import { BrowserRuntimeError } from "@browser-agent-next/core";
import {
  isPrepareStrictClickRequest,
  type PrepareStrictClickResponse,
} from "../../protocol/execution.js";
import type { ExtensionBackgroundRuntimeApi } from "../runtimeApi.js";
import type { ChromeStrictExecutionService } from "./chromeStrictExecutionService.js";

function boundedMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "strict click prepare failed";

  return message.slice(0, 500);
}

function errorCode(error: unknown): string {
  return error instanceof BrowserRuntimeError
    ? error.code
    : "STRICT_PREPARE_FAILED";
}

export function registerStrictExecutionBackgroundListener(
  runtime: ExtensionBackgroundRuntimeApi,
  service: ChromeStrictExecutionService,
): () => void {
  const listener = (
    message: unknown,
    sender: { id?: string },
    sendResponse: (response: PrepareStrictClickResponse) => void,
  ): boolean | void => {
    if (sender.id !== runtime.id) return;
    if (!isPrepareStrictClickRequest(message)) return;

    void service.prepareClick({
      tabId: message.tabId,
      actionId: message.actionId,
      observedRevision: message.observedRevision,
      ref: message.ref,
    }).then(
      (prepared) => {
        sendResponse({
          type: "execution.prepare-strict-click.result",
          requestId: message.requestId,
          ok: true,
          prepared: {
            ref: prepared.ref,
            point: prepared.point,
          },
        });
      },
      (error: unknown) => {
        sendResponse({
          type: "execution.prepare-strict-click.result",
          requestId: message.requestId,
          ok: false,
          error: {
            code: errorCode(error),
            message: boundedMessage(error),
          },
        });
      },
    );

    return true;
  };

  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}
