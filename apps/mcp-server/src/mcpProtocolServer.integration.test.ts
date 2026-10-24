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
  type ModelFacingToolInvoker,
} from "./mcpProtocolServer.js";
import {
  MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
  type ModelToolCallContext,
} from "./modelActBroker.js";
import {
  collectUntilResponse,
  createWire,
  initializeWire,
  resultOf,
} from "./testing/mcpWire.js";

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
              {
                signal:
                  expect.any(
                    AbortSignal,
                  ),
              },
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


/**
 * 启动 stdio server 并完成 initialize / initialized 握手。
 */
async function startInitializedServer(
  invoke: ModelFacingToolInvoker["invoke"],
) {
  const wire = createWire();
  const errors: Error[] = [];
  const transport =
    new StdioServerTransport(
      wire.input,
      wire.output,
      { maxBufferSize: 64 * 1024 },
    );
  const handle =
    serveModelFacingMcpStdio(
      () => ({
        exposedTools: () => [
          "browser.observe",
        ],
        invoke,
      }),
      {
        transport,
        legacy: "serve",
        onerror: (error) => {
          errors.push(error);
        },
      },
    );

  await new Promise<void>(
    (resolve) => setImmediate(resolve),
  );
  const initialized =
    await initializeWire(wire);
  expect(initialized.id).toBe(1);

  return {
    wire,
    errors,
    async close() {
      await handle.close();
      wire.close();
    },
  };
}

describe(
  "model-facing MCP stdio progress 与取消",
  () => {
    it(
      "tools/call 带 _meta.progressToken 时，onProgress 转为 notifications/progress",
      async () => {
        const invoke = vi.fn(
          async (
            _name: string,
            _input: unknown,
            context?: ModelToolCallContext,
          ) => {
            context?.onProgress?.({
              progress: 1,
              message:
                MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
            });
            context?.onProgress?.({
              progress: 2,
              message:
                MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
            });
            return { ok: true };
          },
        );
        const server =
          await startInitializedServer(
            invoke,
          );

        try {
          server.wire.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "browser.observe",
              arguments: { tabId: 7 },
              _meta: {
                progressToken:
                  "progress-token-1",
              },
            },
          });

          const messages =
            await collectUntilResponse(
              server.wire,
              2,
            );
          const progress =
            messages.filter(
              (message) =>
                message.method ===
                "notifications/progress",
            );
          expect(progress).toHaveLength(2);
          expect(
            progress.map(
              (message) => message.params,
            ),
          ).toEqual([
            {
              progressToken:
                "progress-token-1",
              progress: 1,
              message:
                MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
            },
            {
              progressToken:
                "progress-token-1",
              progress: 2,
              message:
                MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
            },
          ]);
          const response =
            messages[messages.length - 1]!;
          expect(
            resultOf(response).isError,
          ).toBeUndefined();
          expect(server.errors).toEqual([]);
        } finally {
          await server.close();
        }
      },
    );

    it(
      "tools/call 不带 progressToken 时不提供 onProgress，也不发送 progress",
      async () => {
        let sawOnProgress:
          boolean | undefined;
        const invoke = vi.fn(
          async (
            _name: string,
            _input: unknown,
            context?: ModelToolCallContext,
          ) => {
            sawOnProgress =
              context?.onProgress !==
              undefined;
            context?.onProgress?.({
              progress: 1,
              message:
                MODEL_ACT_APPROVAL_PROGRESS_MESSAGE,
            });
            return { ok: true };
          },
        );
        const server =
          await startInitializedServer(
            invoke,
          );

        try {
          server.wire.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "browser.observe",
              arguments: { tabId: 7 },
            },
          });

          const messages =
            await collectUntilResponse(
              server.wire,
              2,
            );
          expect(messages).toHaveLength(1);
          expect(
            messages.filter(
              (message) =>
                message.method ===
                "notifications/progress",
            ),
          ).toEqual([]);
          expect(sawOnProgress).toBe(false);

          // 再发一个请求，确认没有迟到的 progress 排在它前面。
          server.wire.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {},
          });
          const later =
            await collectUntilResponse(
              server.wire,
              3,
            );
          expect(later).toHaveLength(1);
        } finally {
          await server.close();
        }
      },
    );

    it(
      "notifications/cancelled 让 invoker 收到的 signal 变为 aborted",
      async () => {
        let received:
          AbortSignal | undefined;
        let markStarted!: () => void;
        const started = new Promise<void>(
          (resolve) => {
            markStarted = resolve;
          },
        );
        let markAborted!: () => void;
        const aborted = new Promise<void>(
          (resolve) => {
            markAborted = resolve;
          },
        );
        const invoke = vi.fn(
          async (
            _name: string,
            _input: unknown,
            context?: ModelToolCallContext,
          ) => {
            received = context?.signal;
            if (received?.aborted) {
              markAborted();
            } else {
              received?.addEventListener(
                "abort",
                () => markAborted(),
                { once: true },
              );
            }
            markStarted();
            await aborted;
            return { ok: true };
          },
        );
        const server =
          await startInitializedServer(
            invoke,
          );

        try {
          server.wire.send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "browser.observe",
              arguments: { tabId: 7 },
            },
          });
          await started;
          expect(received).toBeInstanceOf(
            AbortSignal,
          );
          expect(received?.aborted).toBe(
            false,
          );

          server.wire.send({
            jsonrpc: "2.0",
            method:
              "notifications/cancelled",
            params: {
              requestId: 2,
              reason: "user cancelled",
            },
          });

          await Promise.race([
            aborted,
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "signal was not aborted",
                    ),
                  ),
                2_000,
              ),
            ),
          ]);
          expect(received?.aborted).toBe(
            true,
          );

          // server 仍可继续处理请求；被取消的请求不应再阻塞后续通信。
          server.wire.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {},
          });
          const later =
            await collectUntilResponse(
              server.wire,
              3,
            );
          expect(
            later.some(
              (message) => message.id === 3,
            ),
          ).toBe(true);
        } finally {
          await server.close();
        }
      },
    );
  },
);
