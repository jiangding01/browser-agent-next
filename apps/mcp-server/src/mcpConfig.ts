import {
  MODEL_FACING_TOOL_NAMES,
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
} from "./mcpProtocolServer.js";
import {
  DEFAULT_TRUSTED_RPC_HOST,
  DEFAULT_TRUSTED_RPC_MAX_RESPONSE_BYTES,
  DEFAULT_TRUSTED_RPC_PORT,
  DEFAULT_TRUSTED_RPC_TIMEOUT_MS,
} from "./trustedRuntimeClient.js";

export const MCP_CONFIG_ENV = {
  readOrigins: "BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS",
  navigationOrigins: "BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS",
  tools: "BROWSER_AGENT_NEXT_MODEL_TOOLS",
  includeValues: "BROWSER_AGENT_NEXT_MODEL_INCLUDE_VALUES",
  maxObservationElements:
    "BROWSER_AGENT_NEXT_MODEL_MAX_OBSERVATION_ELEMENTS",
  maxVisibleRevisions:
    "BROWSER_AGENT_NEXT_MODEL_MAX_VISIBLE_REVISIONS",
  rpcHost: "BROWSER_AGENT_NEXT_RPC_HOST",
  rpcPort: "BROWSER_AGENT_NEXT_RPC_PORT",
  rpcTokenPath: "BROWSER_AGENT_NEXT_RPC_TOKEN_PATH",
  rpcTimeoutMs: "BROWSER_AGENT_NEXT_RPC_TIMEOUT_MS",
  rpcMaxResponseBytes:
    "BROWSER_AGENT_NEXT_RPC_MAX_RESPONSE_BYTES",
  mcpMaxResultBytes:
    "BROWSER_AGENT_NEXT_MCP_MAX_RESULT_BYTES",
} as const;

export interface ModelFacingMcpConfig {
  readonly readOrigins: readonly string[];
  readonly navigationOrigins: readonly string[];
  readonly tools: readonly ModelFacingToolName[];
  readonly includeValues: boolean;
  readonly maxObservationElements: number;
  readonly maxVisibleRevisions: number;
  readonly rpcHost: string;
  readonly rpcPort: number;
  readonly rpcTokenPath?: string;
  readonly rpcTimeoutMs: number;
  readonly rpcMaxResponseBytes: number;
  readonly mcpMaxResultBytes: number;
}

function parseList(
  value: string | undefined,
  name: string,
  maxItems: number,
): string[] {
  if (
    value === undefined ||
    value.trim() === ""
  ) {
    return [];
  }

  const items = value
    .split(",")
    .map((item) => item.trim());

  if (
    items.length > maxItems ||
    items.some(
      (item) =>
        item.length === 0 ||
        item.length > 2_048,
    )
  ) {
    throw new Error(
      name +
        " contains an invalid or unbounded list",
    );
  }

  return [...new Set(items)];
}

function parseBoolean(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }
  if (value === "true") return true;
  if (value === "false") return false;

  throw new Error(
    name +
      " must be exactly true or false",
  );
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(
      name + " must be an integer",
    );
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(
      name +
        " must be between " +
        min +
        " and " +
        max,
    );
  }

  return parsed;
}

function parseTools(
  value: string | undefined,
): ModelFacingToolName[] {
  const requested =
    value === undefined ||
    value.trim() === ""
      ? [...MODEL_FACING_TOOL_NAMES]
      : parseList(
          value,
          MCP_CONFIG_ENV.tools,
          MODEL_FACING_TOOL_NAMES.length,
        );

  return new ModelToolExposurePolicy(
    requested,
  ).values();
}

function canonicalOrigins(
  readOrigins: readonly string[],
  navigationOrigins: readonly string[],
): {
  readOrigins: string[];
  navigationOrigins: string[];
} {
  const policy =
    new ModelOriginAccessPolicy({
      readOrigins,
      navigationOrigins,
    });

  return {
    readOrigins:
      policy.readableOrigins(),
    navigationOrigins:
      policy.navigableOrigins(),
  };
}

function parseLoopbackHost(
  value: string | undefined,
): string {
  const host = (
    value?.trim() ||
    DEFAULT_TRUSTED_RPC_HOST
  ).toLowerCase();

  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1"
  ) {
    throw new Error(
      MCP_CONFIG_ENV.rpcHost +
        " must be an explicit loopback host",
    );
  }

  return host;
}

/**
 * 只读取 MCP 进程启动时的 operator 配置。
 *
 * 模型 tool arguments 不会进入这个配置解析路径。
 */
export function loadModelFacingMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModelFacingMcpConfig {
  const origins = canonicalOrigins(
    parseList(
      env[MCP_CONFIG_ENV.readOrigins],
      MCP_CONFIG_ENV.readOrigins,
      100,
    ),
    parseList(
      env[MCP_CONFIG_ENV.navigationOrigins],
      MCP_CONFIG_ENV.navigationOrigins,
      100,
    ),
  );

  const rpcTokenPath =
    env[MCP_CONFIG_ENV.rpcTokenPath]
      ?.trim();

  if (
    rpcTokenPath !== undefined &&
    rpcTokenPath.length === 0
  ) {
    throw new Error(
      MCP_CONFIG_ENV.rpcTokenPath +
        " must not be empty",
    );
  }

  if (
    rpcTokenPath !== undefined &&
    (
      rpcTokenPath.length > 4_096 ||
      rpcTokenPath.includes("\0")
    )
  ) {
    throw new Error(
      MCP_CONFIG_ENV.rpcTokenPath +
        " is invalid",
    );
  }

  const config:
    ModelFacingMcpConfig = {
      readOrigins: Object.freeze(
        origins.readOrigins,
      ),
      navigationOrigins: Object.freeze(
        origins.navigationOrigins,
      ),
      tools: Object.freeze(
        parseTools(
          env[MCP_CONFIG_ENV.tools],
        ),
      ),
      includeValues: parseBoolean(
        env[MCP_CONFIG_ENV.includeValues],
        MCP_CONFIG_ENV.includeValues,
        false,
      ),
      maxObservationElements:
        parseInteger(
          env[
            MCP_CONFIG_ENV
              .maxObservationElements
          ],
          MCP_CONFIG_ENV
            .maxObservationElements,
          100,
          1,
          500,
        ),
      maxVisibleRevisions:
        parseInteger(
          env[
            MCP_CONFIG_ENV
              .maxVisibleRevisions
          ],
          MCP_CONFIG_ENV
            .maxVisibleRevisions,
          64,
          1,
          512,
        ),
      rpcHost: parseLoopbackHost(
        env[MCP_CONFIG_ENV.rpcHost],
      ),
      rpcPort: parseInteger(
        env[MCP_CONFIG_ENV.rpcPort],
        MCP_CONFIG_ENV.rpcPort,
        DEFAULT_TRUSTED_RPC_PORT,
        1,
        65_535,
      ),
      ...(rpcTokenPath !== undefined
        ? { rpcTokenPath }
        : {}),
      rpcTimeoutMs: parseInteger(
        env[MCP_CONFIG_ENV.rpcTimeoutMs],
        MCP_CONFIG_ENV.rpcTimeoutMs,
        DEFAULT_TRUSTED_RPC_TIMEOUT_MS,
        1,
        30_000,
      ),
      rpcMaxResponseBytes:
        parseInteger(
          env[
            MCP_CONFIG_ENV
              .rpcMaxResponseBytes
          ],
          MCP_CONFIG_ENV
            .rpcMaxResponseBytes,
          DEFAULT_TRUSTED_RPC_MAX_RESPONSE_BYTES,
          1_024,
          4 * 1024 * 1024,
        ),
      mcpMaxResultBytes:
        parseInteger(
          env[
            MCP_CONFIG_ENV
              .mcpMaxResultBytes
          ],
          MCP_CONFIG_ENV
            .mcpMaxResultBytes,
          DEFAULT_MCP_RESULT_MAX_BYTES,
          1_024,
          1024 * 1024,
        ),
    };

  return Object.freeze(config);
}
