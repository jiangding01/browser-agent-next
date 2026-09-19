import { BrowserRuntimeError } from "@browser-agent-next/core";
import {
  isTrustedHostRequest,
  TRUSTED_NATIVE_HOST_NAME,
  type TrustedHostRequest,
  type TrustedHostResponse,
} from "../../protocol/trustedHost.js";
import type {
  TrustedHostExecutionService,
} from "./trustedHostExecutionService.js";

export interface TrustedNativePort {
  postMessage(message: TrustedHostResponse): void;
  disconnect(): void;
  onMessage: {
    addListener(
      listener: (message: unknown) => void,
    ): void;
    removeListener(
      listener: (message: unknown) => void,
    ): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

export interface TrustedNativeRuntimeApi {
  connectNative(application: string): TrustedNativePort;
}

function errorResponse(
  requestId: string,
  error: unknown,
): TrustedHostResponse {
  const runtimeError =
    error instanceof BrowserRuntimeError
      ? error
      : undefined;

  return {
    type: "trusted-host.result",
    requestId,
    ok: false,
    error: {
      code: runtimeError?.code ?? "TRUSTED_HOST_REQUEST_FAILED",
      message: (
        error instanceof Error
          ? error.message
          : "trusted host request failed"
      ).slice(0, 500),
      ...(runtimeError?.code === "ACTION_OUTCOME_UNKNOWN"
        ? { outcomeMayHaveChanged: true }
        : {}),
    },
  };
}

async function handleRequest(
  service: TrustedHostExecutionService,
  request: TrustedHostRequest,
): Promise<unknown> {
  switch (request.type) {
    case "policy.replace-autoact-origins":
      return {
        origins: service.replaceAutoActOrigins(
          request.origins,
        ),
      };

    case "authorization.issue-strict-click":
      return service.issueStrictClickAuthorization({
        authorizationId: request.authorizationId,
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ref: request.ref,
        ttlMs: request.ttlMs,
      });

    case "execution.execute-strict-click":
      return service.executeStrictClickAndVerify({
        actionId: request.actionId,
        authorizationId: request.authorizationId,
        tabId: request.tabId,
        observedRevision: request.observedRevision,
        ref: request.ref,
        verification: request.verification,
        ...(request.verifyTimeoutMs !== undefined
          ? { verifyTimeoutMs: request.verifyTimeoutMs }
          : {}),
      });
  }
}

/**
 * 唯一可以签发 trusted-host grant 并进入真实 execute path 的 Extension ingress。
 *
 * 普通 runtime.onMessage listener 只保留 prepare/observe 等非授权能力。
 */
export function connectTrustedNativeIngress(
  runtime: TrustedNativeRuntimeApi,
  service: TrustedHostExecutionService,
  hostName = TRUSTED_NATIVE_HOST_NAME,
): {
  connected: boolean;
  disconnect(): void;
} {
  let port: TrustedNativePort;

  try {
    port = runtime.connectNative(hostName);
  } catch {
    // Native host 未安装 / 未配置时，强安全默认是“不存在执行入口”。
    return {
      connected: false,
      disconnect() {},
    };
  }

  const listener = (message: unknown): void => {
    if (!isTrustedHostRequest(message)) {
      const requestId =
        typeof message === "object" &&
        message !== null &&
        typeof (message as { requestId?: unknown }).requestId === "string"
          ? (message as { requestId: string }).requestId
          : "invalid";

      port.postMessage({
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

    void handleRequest(service, message).then(
      (result) => {
        port.postMessage({
          type: "trusted-host.result",
          requestId: message.requestId,
          ok: true,
          result,
        });
      },
      (error: unknown) => {
        port.postMessage(
          errorResponse(message.requestId, error),
        );
      },
    );
  };

  port.onMessage.addListener(listener);

  return {
    connected: true,
    disconnect() {
      port.onMessage.removeListener(listener);
      port.disconnect();
    },
  };
}
