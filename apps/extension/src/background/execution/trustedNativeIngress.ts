import { BrowserRuntimeError } from "@browser-agent-next/core";
import {
  isTrustedHostRequest,
  TRUSTED_NATIVE_HOST_NAME,
  type TrustedHostRequest,
  type TrustedHostResponse,
} from "../../protocol/trustedHost.js";
import type { HighLevelBrowserApiService } from "../api/browserApiService.js";
import type { TrustedHostExecutionService } from "./trustedHostExecutionService.js";

export interface TrustedNativePort {
  postMessage(message: TrustedHostResponse): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

export interface TrustedNativeRuntimeApi {
  connectNative(application: string): TrustedNativePort;
}

function errorResponse(requestId: string, error: unknown): TrustedHostResponse {
  const runtimeError = error instanceof BrowserRuntimeError ? error : undefined;
  return {
    type: "trusted-host.result",
    requestId,
    ok: false,
    error: {
      code: runtimeError?.code ?? "TRUSTED_HOST_REQUEST_FAILED",
      message: (error instanceof Error ? error.message : "trusted host request failed").slice(0, 500),
      ...(runtimeError?.code === "ACTION_OUTCOME_UNKNOWN"
        ? { outcomeMayHaveChanged: true }
        : {}),
    },
  };
}

async function handleRequest(
  service: TrustedHostExecutionService,
  browserApi: HighLevelBrowserApiService | undefined,
  request: TrustedHostRequest,
): Promise<unknown> {
  switch (request.type) {
    case "policy.replace-autoact-origins":
      return { origins: service.replaceAutoActOrigins(request.origins) };
    case "authorization.issue-strict-click":
      return service.issueStrictClickAuthorization({
        authorizationId: request.authorizationId,
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ref: request.ref,
        ttlMs: request.ttlMs,
      });
    case "authorization.request-operator-approval":
      return service.requestOperatorApproval({
        authorizationId: request.authorizationId,
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ref: request.ref,
        ttlMs: request.ttlMs,
      });
    case "authorization.operator-approval-status":
      return service.operatorApprovalStatus(
        request.approvalRequestId,
      );
    case "execution.execute-strict-click":
      return service.executeStrictClickAndVerify({
        actionId: request.actionId,
        authorizationId: request.authorizationId,
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ref: request.ref,
        verification: request.verification,
        ...(request.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: request.verifyTimeoutMs } : {}),
      });
    case "browser.open":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.open({
        url: request.url,
        ...(request.active !== undefined
          ? { active: request.active }
          : {}),
      });
    case "browser.observe":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.observe({
        tabId: request.tabId,
        ...(request.sinceRevision !== undefined ? { sinceRevision: request.sinceRevision } : {}),
        ...(request.options !== undefined ? { options: request.options } : {}),
      });
    case "browser.extract":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.extract({
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ...(request.refs !== undefined
          ? { refs: request.refs }
          : {}),
        ...(request.maxItems !== undefined
          ? { maxItems: request.maxItems }
          : {}),
      });
    case "browser.verify":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.verify({
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        verification: request.verification,
      });
    case "browser.wait":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.wait({
        tabId: request.tabId,
        verification: request.verification,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.pollIntervalMs !== undefined ? { pollIntervalMs: request.pollIntervalMs } : {}),
        ...(request.options !== undefined ? { options: request.options } : {}),
      });
    case "browser.act":
      if (!browserApi) throw new Error("high-level browser API is unavailable");
      return browserApi.act({
        tabId: request.tabId,
        action: request.action,
        verification: request.verification,
        ...(request.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: request.verifyTimeoutMs } : {}),
      });
  }
}

export function connectTrustedNativeIngress(
  runtime: TrustedNativeRuntimeApi,
  service: TrustedHostExecutionService,
  hostOrBrowserApi: string | HighLevelBrowserApiService = TRUSTED_NATIVE_HOST_NAME,
  optionalBrowserApi?: HighLevelBrowserApiService,
): { connected: boolean; disconnect(): void } {
  const hostName = typeof hostOrBrowserApi === "string"
    ? hostOrBrowserApi
    : TRUSTED_NATIVE_HOST_NAME;
  const browserApi = typeof hostOrBrowserApi === "string"
    ? optionalBrowserApi
    : hostOrBrowserApi;

  let port: TrustedNativePort;
  try {
    port = runtime.connectNative(hostName);
  } catch {
    return { connected: false, disconnect() {} };
  }

  let active = true;

  const listener = (message: unknown): void => {
    if (!active) return;

    if (!isTrustedHostRequest(message)) {
      const requestId =
        typeof message === "object" && message !== null &&
        typeof (message as { requestId?: unknown }).requestId === "string"
          ? (message as { requestId: string }).requestId
          : "invalid";
      safePost({
        type: "trusted-host.result",
        requestId,
        ok: false,
        error: {
          code: "INVALID_TRUSTED_HOST_REQUEST",
          message: "trusted host message failed schema validation",
        },
      });
      return;
    }

    void handleRequest(service, browserApi, message).then(
      (result) => {
        safePost({
          type: "trusted-host.result",
          requestId: message.requestId,
          ok: true,
          result,
        });
      },
      (error: unknown) => {
        safePost(errorResponse(message.requestId, error));
      },
    );
  };

  const deactivate = (disconnectPort: boolean): void => {
    if (!active) return;
    active = false;
    port.onMessage.removeListener(listener);
    port.onDisconnect.removeListener(onDisconnect);
    if (disconnectPort) {
      try {
        port.disconnect();
      } catch {
        // The port is already unusable; never retry or replay the request.
      }
    }
  };

  const safePost = (message: TrustedHostResponse): void => {
    if (!active) return;
    try {
      port.postMessage(message);
    } catch {
      deactivate(true);
    }
  };

  const onDisconnect = (): void => {
    deactivate(false);
  };

  port.onMessage.addListener(listener);
  port.onDisconnect.addListener(onDisconnect);
  return {
    connected: true,
    disconnect() {
      deactivate(true);
    },
  };
}
