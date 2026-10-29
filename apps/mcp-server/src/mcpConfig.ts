import {
  ExactOriginAllowlist,
  MODEL_FACING_DEFAULT_TOOL_NAMES,
  MODEL_FACING_TOOL_NAMES,
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  isAbsolute,
} from "node:path";
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
} from "./mcpProtocolServer.js";
import {
  DEFAULT_TRACE_MAX_BYTES,
  MAX_TRACE_MAX_BYTES,
  MIN_TRACE_MAX_BYTES,
} from "./traceFileSink.js";
import {
  DEFAULT_TRUSTED_RPC_HOST,
  DEFAULT_TRUSTED_RPC_MAX_RESPONSE_BYTES,
  DEFAULT_TRUSTED_RPC_PORT,
  DEFAULT_TRUSTED_RPC_TIMEOUT_MS,
} from "./trustedRuntimeClient.js";

export const MCP_CONFIG_ENV = {
  readOrigins: "BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS",
  navigationOrigins: "BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS",
  actOrigins: "BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS",
  actBudget: "BROWSER_AGENT_NEXT_MODEL_ACT_BUDGET",
  actApproval: "BROWSER_AGENT_NEXT_MODEL_ACT_APPROVAL",
  approvalTimeoutMs:
    "BROWSER_AGENT_NEXT_MODEL_APPROVAL_TIMEOUT_MS",
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
  traceDir: "BROWSER_AGENT_NEXT_TRACE_DIR",
  traceMaxBytes: "BROWSER_AGENT_NEXT_TRACE_MAX_BYTES",
} as const;

export type ModelActApprovalMode =
  | "operator"
  | "agent-owned-auto";

export interface ModelFacingMcpConfig {
  readonly readOrigins: readonly string[];
  readonly navigationOrigins: readonly string[];
  readonly actOrigins: readonly string[];
  readonly actBudget: number;
  readonly actApproval: ModelActApprovalMode;
  readonly approvalTimeoutMs: number;
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
  /** 未设置时不产生 trace（默认关闭）。 */
  readonly traceDir?: string;
  readonly traceMaxBytes: number;
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
      ? [...MODEL_FACING_DEFAULT_TOOL_NAMES]
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

function parseActApproval(
  value: string | undefined,
): ModelActApprovalMode {
  if (
    value === undefined ||
    value === ""
  ) {
    return "operator";
  }
  if (
    value === "operator" ||
    value === "agent-owned-auto"
  ) {
    return value;
  }

  throw new Error(
    MCP_CONFIG_ENV.actApproval +
      " must be operator or agent-owned-auto",
  );
}

/**
 * act plane 是独立于 read/navigation 的第三个 origin 配置，
 * 但必须是 read plane 的子集：模型不能对自己读不到的 origin 发起动作。
 */
function canonicalActOrigins(
  actOrigins: readonly string[],
  readOrigins: readonly string[],
): string[] {
  const canonical =
    new ExactOriginAllowlist(
      actOrigins,
    ).values();
  const readable = new Set(readOrigins);

  for (const origin of canonical) {
    if (!readable.has(origin)) {
      throw new Error(
        MCP_CONFIG_ENV.actOrigins +
          " must be a subset of " +
          MCP_CONFIG_ENV.readOrigins +
          ": " +
          origin,
      );
    }
  }

  return canonical;
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

  const actOrigins =
    canonicalActOrigins(
      parseList(
        env[MCP_CONFIG_ENV.actOrigins],
        MCP_CONFIG_ENV.actOrigins,
        100,
      ),
      origins.readOrigins,
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

  const traceDir = parseTraceDirectory(
    env[MCP_CONFIG_ENV.traceDir],
  );

  const config:
    ModelFacingMcpConfig = {
      readOrigins: Object.freeze(
        origins.readOrigins,
      ),
      navigationOrigins: Object.freeze(
        origins.navigationOrigins,
      ),
      actOrigins: Object.freeze(
        actOrigins,
      ),
      actBudget: parseInteger(
        env[MCP_CONFIG_ENV.actBudget],
        MCP_CONFIG_ENV.actBudget,
        16,
        1,
        256,
      ),
      actApproval: parseActApproval(
        env[MCP_CONFIG_ENV.actApproval],
      ),
      approvalTimeoutMs: parseInteger(
        env[
          MCP_CONFIG_ENV
            .approvalTimeoutMs
        ],
        MCP_CONFIG_ENV
          .approvalTimeoutMs,
        60_000,
        1,
        120_000,
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
      ...(traceDir !== undefined
        ? { traceDir }
        : {}),
      traceMaxBytes: parseInteger(
        env[MCP_CONFIG_ENV.traceMaxBytes],
        MCP_CONFIG_ENV.traceMaxBytes,
        DEFAULT_TRACE_MAX_BYTES,
        MIN_TRACE_MAX_BYTES,
        MAX_TRACE_MAX_BYTES,
      ),
    };

  return Object.freeze(config);
}

/**
 * trace 目录只来自 operator 进程环境（不变量 136）；
 * 目录本身的权限与类型在打开 sink 时校验。
 */
function parseTraceDirectory(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;

  const directory = value.trim();
  if (
    directory.length === 0 ||
    directory.length > 4_096 ||
    directory.includes("\0") ||
    !isAbsolute(directory)
  ) {
    throw new Error(
      MCP_CONFIG_ENV.traceDir +
        " must be an absolute directory path",
    );
  }

  return directory;
}
