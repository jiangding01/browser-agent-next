import {
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";
import {
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  createModelFacingMcpToolCatalog,
} from "./modelToolCatalog.js";
import type {
  ModelToolCallContext,
} from "./modelActBroker.js";

export const DEFAULT_MCP_RESULT_MAX_BYTES = 256 * 1024;

export interface ModelFacingToolInvoker {
  exposedTools(): ModelFacingToolName[];
  invoke(
    tool: string,
    input: unknown,
    context?: ModelToolCallContext,
  ): Promise<unknown>;
}

export interface ModelFacingMcpServerOptions {
  name?: string;
  version?: string;
  maxResultBytes?: number;
}

export interface ServeModelFacingMcpStdioOptions
  extends ModelFacingMcpServerOptions {
  legacy?: ServeStdioOptions["legacy"];
  transport?: ServeStdioOptions["transport"];
  onerror?: ServeStdioOptions["onerror"];
}

function boundedPositiveInteger(
  value: number,
  name: string,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(
      name + " must be an integer between 1 and " + max,
    );
  }
  return value;
}

function jsonTextResult(
  value: unknown,
  maxBytes: number,
): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return toolError(
      "MODEL_EGRESS_BLOCKED",
      "tool result could not be serialized safely",
    );
  }

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return toolError(
      "MODEL_EGRESS_BLOCKED",
      "tool result exceeded the model-facing MCP result bound",
    );
  }

  return {
    content: [{ type: "text", text }],
  };
}

function toolError(
  code: string,
  message: string,
): CallToolResult {
  const safe = JSON.stringify({
    ok: false,
    error: {
      code: code.slice(0, 64),
      message: message.slice(0, 500),
    },
  });

  return {
    content: [{ type: "text", text: safe }],
    isError: true,
  };
}

function normalizedToolError(error: unknown): CallToolResult {
  if (error instanceof BrowserRuntimeError) {
    return toolError(error.code, error.message);
  }

  return toolError(
    "INTERNAL_ERROR",
    "model-facing tool execution failed",
  );
}

export class ModelFacingMcpBridge {
  private readonly catalog: readonly Tool[];
  private readonly allowedTools: ReadonlySet<string>;
  private readonly maxResultBytes: number;

  constructor(
    private readonly invoker: ModelFacingToolInvoker,
    options: ModelFacingMcpServerOptions = {},
  ) {
    const exposure = new ModelToolExposurePolicy(
      invoker.exposedTools(),
    );
    this.catalog = createModelFacingMcpToolCatalog(
      exposure,
    ).map((tool): Tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema:
        tool.inputSchema as Tool["inputSchema"],
    }));
    this.allowedTools = new Set(
      this.catalog.map((tool) => tool.name),
    );
    this.maxResultBytes = boundedPositiveInteger(
      options.maxResultBytes ?? DEFAULT_MCP_RESULT_MAX_BYTES,
      "maxResultBytes",
      1024 * 1024,
    );
  }

  listTools(): readonly Tool[] {
    return this.catalog;
  }

  async callTool(
    name: string,
    input: unknown,
    context?: ModelToolCallContext,
  ): Promise<CallToolResult> {
    if (!this.allowedTools.has(name)) {
      return toolError(
        "POLICY_BLOCKED",
        "model-facing tool is not exposed: " +
          name.slice(0, 128),
      );
    }

    try {
      const result = await this.invoker.invoke(
        name,
        input,
        context,
      );
      return jsonTextResult(
        result,
        this.maxResultBytes,
      );
    } catch (error) {
      return normalizedToolError(error);
    }
  }
}

export function createModelFacingMcpServer(
  invoker: ModelFacingToolInvoker,
  options: ModelFacingMcpServerOptions = {},
): Server {
  const bridge = new ModelFacingMcpBridge(
    invoker,
    options,
  );
  const server = new Server(
    {
      name: options.name ?? "browser-agent-next",
      version: options.version ?? "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [...bridge.listTools()],
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const progressToken = request.params._meta?.progressToken;
    const context: ModelToolCallContext = {
      signal: ctx.mcpReq.signal,
      // progress 只含递增计数与固定文本；客户端未请求时不发送。
      ...(progressToken !== undefined
        ? {
            onProgress: (progress) => {
              void ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: progress.progress,
                    message: progress.message,
                  },
                })
                .catch(() => undefined);
            },
          }
        : {}),
    };

    return bridge.callTool(
      request.params.name,
      request.params.arguments ?? {},
      context,
    );
  });

  return server;
}

/**
 * 使用官方 v2 serveStdio 入口建立 connection-pinned MCP server。
 *
 * createInvoker 必须在 factory 内执行：每个连接得到独立的 model-visible
 * revision store，不能跨模型连接共享 projected state。
 */
export function serveModelFacingMcpStdio(
  createInvoker: () => ModelFacingToolInvoker,
  options: ServeModelFacingMcpStdioOptions = {},
): StdioServerHandle {
  return serveStdio(
    () => createModelFacingMcpServer(
      createInvoker(),
      options,
    ),
    {
      legacy: options.legacy ?? "serve",
      ...(options.transport !== undefined
        ? { transport: options.transport }
        : {}),
      ...(options.onerror !== undefined
        ? { onerror: options.onerror }
        : {}),
    },
  );
}
