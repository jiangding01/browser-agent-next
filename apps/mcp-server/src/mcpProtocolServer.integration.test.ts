import {
  PassThrough,
} from "node:stream";
import {
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  serveModelFacingMcpStdio,
} from "./mcpProtocolServer.js";

type JsonRpcMessage =
  Record<string, unknown>;

function createWire() {
  const input = new PassThrough();
  const output = new PassThrough();
  const queued: JsonRpcMessage[] = [];
  const waiters: Array<
    (message: JsonRpcMessage) => void
  > = [];
  let buffer = "";
  let parseError:
    Error | undefined;

  output.on("data", (chunk) => {
    buffer += Buffer
      .from(chunk)
      .toString("utf8");

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
      timeoutMs = 2_000,
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
    close() {
      input.end();
      output.end();
    },
  };
}

function resultOf(
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

describe(
  "model-facing MCP stdio integration",
  () => {
    it(
      "完成 initialize → tools/list → tools/call，并在 wire 上拒绝未暴露工具",
      async () => {
        const wire = createWire();
        const errors: Error[] = [];
        const invoke = vi.fn(
          async (
            name: string,
            input: unknown,
          ) => ({
            name,
            input,
            revision: "rev-1",
          }),
        );
        let factoryCalls = 0;

        const transport =
          new StdioServerTransport(
            wire.input,
            wire.output,
            {
              maxBufferSize:
                64 * 1024,
            },
          );

        const handle =
          serveModelFacingMcpStdio(
            () => {
              factoryCalls += 1;
              return {
                exposedTools: () => [
                  "browser.observe",
                ],
                invoke,
              };
            },
            {
              transport,
              legacy: "serve",
              onerror: (error) => {
                errors.push(error);
              },
            },
          );

        try {
          await new Promise<void>(
            (resolve) =>
              setImmediate(resolve),
          );

          wire.send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion:
                "2025-06-18",
              capabilities: {},
              clientInfo: {
                name:
                  "browser-agent-next-test",
                version: "1.0.0",
              },
            },
          });

          const initialized =
            await wire.next();
          expect(initialized.id)
            .toBe(1);
          expect(
            resultOf(
              initialized,
            ).serverInfo,
          ).toMatchObject({
            name:
              "browser-agent-next",
          });

          wire.send({
            jsonrpc: "2.0",
            method:
              "notifications/initialized",
            params: {},
          });

          wire.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          });

          const listed =
            await wire.next();
          expect(listed.id)
            .toBe(2);

          const tools =
            resultOf(listed).tools;
          expect(
            Array.isArray(tools)
              ? tools.map(
                  (tool) =>
                    (
                      tool as {
                        name?: unknown;
                      }
                    ).name,
                )
              : [],
          ).toEqual([
            "browser.observe",
          ]);

          wire.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name:
                "browser.observe",
              arguments: {
                tabId: 7,
              },
            },
          });

          const called =
            await wire.next();
          expect(called.id)
            .toBe(3);
          const content =
            resultOf(
              called,
            ).content;
          expect(
            Array.isArray(content)
              ? (
                  content[0] as {
                    text?: unknown;
                  }
                )?.text
              : undefined,
          ).toContain(
            "\"revision\":\"rev-1\"",
          );

          wire.send({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name:
                "browser.open",
              arguments: {
                url:
                  "https://blocked.test/",
              },
            },
          });

          const blocked =
            await wire.next();
          expect(blocked.id)
            .toBe(4);

          const blockedResult =
            resultOf(blocked);
          expect(
            blockedResult.isError,
          ).toBe(true);
          expect(
            JSON.stringify(
              blockedResult.content,
            ),
          ).toContain(
            "POLICY_BLOCKED",
          );

          expect(invoke)
            .toHaveBeenCalledTimes(1);
          expect(invoke)
            .toHaveBeenCalledWith(
              "browser.observe",
              { tabId: 7 },
            );
          expect(factoryCalls)
            .toBe(1);
          expect(errors)
            .toEqual([]);
        } finally {
          await handle.close();
          wire.close();
        }
      },
    );
  },
);
