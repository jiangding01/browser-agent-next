import {
  PassThrough,
} from "node:stream";

/**
 * 测试专用：内存中的 MCP stdio wire。
 *
 * input 交给 StdioServerTransport 读取客户端消息，output 收集服务端写出的
 * 换行分隔 JSON-RPC。除逐条解析外还保留完整原始输出（transcript），
 * 便于断言 wire 上从未出现某个字符串（如 trusted token 或出境标记）。
 */

export type JsonRpcMessage =
  Record<string, unknown>;

export const DEFAULT_WIRE_TIMEOUT_MS = 2_000;

export interface McpWire {
  readonly input: PassThrough;
  readonly output: PassThrough;
  send(message: JsonRpcMessage): void;
  next(timeoutMs?: number): Promise<JsonRpcMessage>;
  /** 服务端写到 wire 上的全部原始字节（含尚未成行的尾部）。 */
  transcript(): string;
  close(): void;
}

export function createWire(): McpWire {
  const input = new PassThrough();
  const output = new PassThrough();
  const queued: JsonRpcMessage[] = [];
  const waiters: Array<
    (message: JsonRpcMessage) => void
  > = [];
  let buffer = "";
  let raw = "";
  let parseError:
    Error | undefined;

  output.on("data", (chunk) => {
    const text = Buffer
      .from(chunk)
      .toString("utf8");
    raw += text;
    buffer += text;

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;

      const line =
        buffer.slice(0, newline).trim();
      buffer =
        buffer.slice(newline + 1);

      if (!line) continue;

      try {
        const message =
          JSON.parse(line) as
            JsonRpcMessage;
        const waiter =
          waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          queued.push(message);
        }
      } catch (error) {
        parseError =
          error instanceof Error
            ? error
            : new Error(
                "failed to parse MCP output",
              );
      }
    }
  });

  return {
    input,
    output,
    send(message: JsonRpcMessage) {
      input.write(
        JSON.stringify(message) +
          "\n",
      );
    },
    async next(
      timeoutMs = DEFAULT_WIRE_TIMEOUT_MS,
    ): Promise<JsonRpcMessage> {
      if (parseError) {
        throw parseError;
      }

      const ready = queued.shift();
      if (ready) return ready;

      return new Promise(
        (resolve, reject) => {
          const timer = setTimeout(
            () => {
              const index =
                waiters.indexOf(
                  onMessage,
                );
              if (index >= 0) {
                waiters.splice(
                  index,
                  1,
                );
              }
              reject(
                new Error(
                  "timed out waiting for MCP response",
                ),
              );
            },
            timeoutMs,
          );

          const onMessage = (
            message:
              JsonRpcMessage,
          ): void => {
            clearTimeout(timer);
            resolve(message);
          };

          waiters.push(onMessage);
        },
      );
    },
    transcript() {
      return raw;
    },
    close() {
      input.end();
      output.end();
    },
  };
}

export function resultOf(
  message: JsonRpcMessage,
): Record<string, unknown> {
  const result = message.result;
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result)
  ) {
    throw new Error(
      "expected JSON-RPC result object",
    );
  }
  return result as
    Record<string, unknown>;
}

/** 读取消息直到拿到指定 id 的 response，返回期间收到的全部消息。 */
export async function collectUntilResponse(
  wire: McpWire,
  id: number,
  timeoutMs = DEFAULT_WIRE_TIMEOUT_MS,
): Promise<JsonRpcMessage[]> {
  const messages: JsonRpcMessage[] = [];
  while (true) {
    const message = await wire.next(
      timeoutMs,
    );
    messages.push(message);
    if (message.id === id) {
      return messages;
    }
  }
}

/**
 * 发送 initialize 并读取其 response，再发送 notifications/initialized。
 * 返回 initialize 的 response，调用方自行断言。
 */
export async function initializeWire(
  wire: McpWire,
  id = 1,
): Promise<JsonRpcMessage> {
  wire.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "browser-agent-next-test",
        version: "1.0.0",
      },
    },
  });
  const initialized = await wire.next();
  wire.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  return initialized;
}

/** tools/call 的 content[0].text 解析为 JSON。 */
export function toolPayload(
  message: JsonRpcMessage,
): Record<string, unknown> {
  const content = resultOf(message).content;
  const first = Array.isArray(content)
    ? content[0] as { text?: unknown } | undefined
    : undefined;
  if (typeof first?.text !== "string") {
    throw new Error(
      "expected tools/call text content",
    );
  }
  return JSON.parse(first.text) as
    Record<string, unknown>;
}
