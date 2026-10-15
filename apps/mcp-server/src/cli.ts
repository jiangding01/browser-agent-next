#!/usr/bin/env node
import {
  pathToFileURL,
} from "node:url";
import {
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
} from "@browser-agent-next/policy";
import {
  createModelActBroker,
} from "./modelActBroker.js";
import {
  ModelFacingBrowserAdapter,
} from "./modelFacingAdapter.js";
import {
  loadModelFacingMcpConfig,
  type ModelFacingMcpConfig,
} from "./mcpConfig.js";
import {
  serveModelFacingMcpStdio,
} from "./mcpProtocolServer.js";
import {
  TrustedRuntimeHttpClient,
  readTrustedRpcToken,
} from "./trustedRuntimeClient.js";

export function createModelFacingInvoker(
  config: ModelFacingMcpConfig,
  trustedToken =
    readTrustedRpcToken(
      config.rpcTokenPath,
    ),
): ModelFacingBrowserAdapter {
  const runtime =
    new TrustedRuntimeHttpClient({
      token: trustedToken,
      host: config.rpcHost,
      port: config.rpcPort,
      timeoutMs:
        config.rpcTimeoutMs,
      maxResponseBytes:
        config.rpcMaxResponseBytes,
    });

  // 每个连接独立 broker：预算、(tab, revision, ref) 账本与降级状态天然 per-connection。
  // 同一个 trusted client 实例同时作为 ModelBrowserRuntimeClient 与
  // TrustedActBrokerRuntimeClient；未暴露 browser.act 时不创建 broker。
  const actBroker =
    config.tools.includes("browser.act")
      ? createModelActBroker(runtime, {
          actOrigins: config.actOrigins,
          budget: config.actBudget,
          approvalMode: config.actApproval,
          approvalTimeoutMs:
            config.approvalTimeoutMs,
        })
      : undefined;

  return new ModelFacingBrowserAdapter(
    runtime,
    {
      tools:
        new ModelToolExposurePolicy(
          config.tools,
        ),
      origins:
        new ModelOriginAccessPolicy({
          readOrigins:
            config.readOrigins,
          navigationOrigins:
            config.navigationOrigins,
        }),
      egress: {
        includeValues:
          config.includeValues,
        maxObservationElements:
          config.maxObservationElements,
        maxVisibleRevisions:
          config.maxVisibleRevisions,
      },
      ...(actBroker !== undefined
        ? { actBroker }
        : {}),
    },
  );
}

export function startModelFacingMcp(
  env: NodeJS.ProcessEnv =
    process.env,
) {
  const config =
    loadModelFacingMcpConfig(env);

  // 在 stdio wire 启动前先验证 trusted token，
  // 配置错误只会进入 stderr，不会污染协议 stdout。
  const trustedToken =
    readTrustedRpcToken(
      config.rpcTokenPath,
    );

  return serveModelFacingMcpStdio(
    () =>
      createModelFacingInvoker(
        config,
        trustedToken,
      ),
    {
      name: "browser-agent-next",
      version: "0.1.0",
      maxResultBytes:
        config.mcpMaxResultBytes,
      legacy: "serve",
    },
  );
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];

  return (
    entry !== undefined &&
    import.meta.url ===
      pathToFileURL(entry).href
  );
}

if (isDirectExecution()) {
  try {
    startModelFacingMcp();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "unknown startup error";

    // stdout 属于 MCP wire，启动错误只能写 stderr。
    console.error(
      "[browser-agent-next/mcp] startup failed: " +
        message.slice(0, 500),
    );
    process.exitCode = 1;
  }
}
