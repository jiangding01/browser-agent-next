import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSecureDirectory } from "./tokenFile.js";
import type { TrustedBridgeRequest } from "./trustedRpcServer.js";

export const AUTOACT_ORIGINS_FILENAME = "autoact-origins.json";
export const AUTOACT_ORIGINS_MAX_BYTES = 64 * 1024;
export const AUTOACT_ORIGINS_MAX_ENTRIES = 100;
export const AUTOACT_ORIGIN_MAX_LENGTH = 2048;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertSafeConfigFile(path: string): void {
  const stat = lstatSync(path);

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "auto-act origins config must be a regular file, not a symlink",
    );
  }

  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      "auto-act origins config must be owned by the current user",
    );
  }

  // origins 不是机密，不强制 0600，但绝不能被组或其他用户写入。
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(
      "auto-act origins config must not be writable by group or others",
    );
  }

  if (stat.size > AUTOACT_ORIGINS_MAX_BYTES) {
    throw new Error(
      "auto-act origins config exceeds " +
        AUTOACT_ORIGINS_MAX_BYTES +
        " bytes",
    );
  }
}

function assertPureOrigin(entry: unknown, index: number): string {
  const label = "auto-act origins config entry " + index;

  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(label + " must be a non-empty string");
  }

  if (entry.length > AUTOACT_ORIGIN_MAX_LENGTH) {
    throw new Error(
      label + " exceeds " + AUTOACT_ORIGIN_MAX_LENGTH + " characters",
    );
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(label + " is not a valid URL origin");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(label + " must use http: or https:");
  }

  if (url.origin !== entry) {
    throw new Error(
      label +
        " must be a pure origin without path, query, fragment or credentials",
    );
  }

  return entry;
}

function parseConfig(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("auto-act origins config is not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("auto-act origins config must be a JSON object");
  }

  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "origins" ||
    keys[1] !== "version"
  ) {
    throw new Error(
      'auto-act origins config must contain exactly the keys "version" and "origins"',
    );
  }

  const { version, origins } = parsed as {
    version: unknown;
    origins: unknown;
  };

  if (version !== 1) {
    throw new Error("auto-act origins config version must be 1");
  }

  if (!Array.isArray(origins)) {
    throw new Error("auto-act origins config origins must be an array");
  }

  if (origins.length > AUTOACT_ORIGINS_MAX_ENTRIES) {
    throw new Error(
      "auto-act origins config has more than " +
        AUTOACT_ORIGINS_MAX_ENTRIES +
        " origins",
    );
  }

  return [
    ...new Set(
      origins.map((entry, index) => assertPureOrigin(entry, index)),
    ),
  ];
}

/**
 * 读取 auto-act origins 配置。
 * - 文件（或目录）不存在返回 undefined。
 * - 任何校验失败都抛出 Error，整份文件作废，不做部分应用。
 */
export function readAutoActOriginsConfig(
  dir: string,
  filename = AUTOACT_ORIGINS_FILENAME,
): string[] | undefined {
  try {
    assertSecureDirectory(dir);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const path = join(dir, filename);

  try {
    assertSafeConfigFile(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const buffer = readFileSync(path);
  if (buffer.length > AUTOACT_ORIGINS_MAX_BYTES) {
    throw new Error(
      "auto-act origins config exceeds " +
        AUTOACT_ORIGINS_MAX_BYTES +
        " bytes",
    );
  }

  return parseConfig(buffer.toString("utf8"));
}

function describeFailure(response: unknown): string {
  if (typeof response === "object" && response !== null) {
    const error = (response as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as {
        code?: unknown;
        message?: unknown;
      };
      const parts = [code, message].filter(
        (part): part is string => typeof part === "string",
      );
      if (parts.length > 0) return parts.join(": ");
    }
  }
  return "extension rejected the request";
}

/**
 * 读取配置并通过 forward 下发给扩展。所有失败只记录日志、不抛出，
 * 此时扩展 allowlist 保持为空（fail closed）。日志只写 stderr，且只记数量。
 */
export async function bootstrapAutoActOrigins(
  readConfig: () => string[] | undefined,
  forward: (request: TrustedBridgeRequest) => Promise<unknown>,
  log: (message: string) => void,
): Promise<void> {
  let origins: string[] | undefined;
  try {
    origins = readConfig();
  } catch (error) {
    log(
      "auto-act origins config rejected: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }

  if (origins === undefined) return;

  try {
    const response = await forward({
      type: "policy.replace-autoact-origins",
      requestId: "native-autoact-bootstrap-" + randomUUID(),
      origins,
    });

    if (
      typeof response === "object" &&
      response !== null &&
      (response as { ok?: unknown }).ok === true
    ) {
      log("auto-act origins pushed to extension: " + origins.length);
    } else {
      log("auto-act origins push failed: " + describeFailure(response));
    }
  } catch (error) {
    log(
      "auto-act origins push failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
