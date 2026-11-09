import { JEV_ENDPOINT } from "./jevRequest.js";

export const JEV_TIMEOUT_MS = 3000;

export type JevProviderErrorKind =
  | "http"
  | "timeout"
  | "network"
  | "invalid-response"
  | "invalid-request";

/**
 * Jev provider 的失败。message 只由固定文案与 status 组成：
 * 不附带响应体、请求体或底层错误（响应体可能回显 state 中的页面文本），也不设置 cause（不变量 168）。
 */
export interface JevProviderError extends Error {
  readonly name: "JevProviderError";
  readonly kind: JevProviderErrorKind;
  readonly status?: number;
}

const MESSAGES: Record<JevProviderErrorKind, string> = {
  http: "jev request failed with HTTP status",
  timeout: "jev request timed out",
  network: "jev request failed before a response arrived",
  "invalid-response": "jev response did not match the request",
  "invalid-request": "jev request could not be built from the input",
};

export function jevProviderError(
  kind: JevProviderErrorKind,
  status?: number,
): JevProviderError {
  const message =
    status === undefined ? MESSAGES[kind] : MESSAGES[kind] + " " + status;
  return Object.assign(new Error(message), {
    name: "JevProviderError" as const,
    kind,
    ...(status !== undefined ? { status } : {}),
  });
}

export function isJevProviderError(value: unknown): value is JevProviderError {
  return value instanceof Error && value.name === "JevProviderError";
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export interface JevHttpResult {
  json: unknown;
  latencyMs: number;
}

/** 单次请求，不重试（docs/JEV-PROVIDER.md「客户端」）。 */
export async function postSystemOne(input: {
  apiKey: string;
  body: unknown;
  fetch: typeof fetch;
}): Promise<JevHttpResult> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await input.fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + input.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      // 不跟随重定向：307/308 会把含页面文本的请求体重发到另一个主机。
      redirect: "error",
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    throw jevProviderError(isTimeout(error) ? "timeout" : "network");
  }

  if (!response.ok) {
    throw jevProviderError("http", response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw jevProviderError(isTimeout(error) ? "timeout" : "invalid-response");
  }
  return { json, latencyMs: Date.now() - startedAt };
}
