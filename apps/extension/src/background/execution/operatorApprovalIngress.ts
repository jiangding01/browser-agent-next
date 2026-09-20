import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import {
  isOperatorApprovalUiRequest,
  type OperatorApprovalUiResponse,
} from "../../protocol/operatorApproval.js";
import type {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

export interface OperatorApprovalMessageSender {
  id?: string;
  url?: string;
}

export interface OperatorApprovalRuntimeApi {
  id: string;
  getURL(path: string): string;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender:
          OperatorApprovalMessageSender,
        sendResponse: (
          response:
            OperatorApprovalUiResponse,
        ) => void,
      ) => boolean | void,
    ): void;
    removeListener(
      listener: (
        message: unknown,
        sender:
          OperatorApprovalMessageSender,
        sendResponse: (
          response:
            OperatorApprovalUiResponse,
        ) => void,
      ) => boolean | void,
    ): void;
  };
}

function errorResponse(
  requestId: string,
  error: unknown,
): OperatorApprovalUiResponse {
  return {
    type:
      "operator-approval.result",
    requestId,
    ok: false,
    error: {
      code:
        error instanceof
        BrowserRuntimeError
          ? error.code
          : "OPERATOR_APPROVAL_FAILED",
      message: (
        error instanceof Error
          ? error.message
          : "operator approval failed"
      ).slice(0, 500),
    },
  };
}

export function registerOperatorApprovalUiIngress(
  runtime:
    OperatorApprovalRuntimeApi,
  approvals:
    OperatorApprovalStore,
  pagePath =
    "operator-approval.html",
): () => void {
  const trustedUrl =
    runtime.getURL(pagePath);

  const listener = (
    message: unknown,
    sender:
      OperatorApprovalMessageSender,
    sendResponse: (
      response:
        OperatorApprovalUiResponse,
    ) => void,
  ): boolean | void => {
    if (
      sender.id !== runtime.id ||
      sender.url !== trustedUrl
    ) {
      return;
    }

    if (
      !isOperatorApprovalUiRequest(
        message,
      )
    ) {
      return;
    }

    try {
      const result = (() => {
        switch (message.type) {
          case
            "operator-approval.list":
            return (
              approvals
                .listPending()
            );

          case
            "operator-approval.approve":
            return (
              approvals.approve(
                message
                  .approvalRequestId,
              )
            );

          case
            "operator-approval.reject":
            return (
              approvals.reject(
                message
                  .approvalRequestId,
              )
            );
        }
      })();

      sendResponse({
        type:
          "operator-approval.result",
        requestId:
          message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      sendResponse(
        errorResponse(
          message.requestId,
          error,
        ),
      );
    }
  };

  runtime.onMessage
    .addListener(listener);

  return () =>
    runtime.onMessage
      .removeListener(listener);
}
