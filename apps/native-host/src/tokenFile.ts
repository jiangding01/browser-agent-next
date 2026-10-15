import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const TOKEN_REGEX = /^[a-f0-9]{64}$/;

export function assertSecureDirectory(path: string): void {
  const stat = lstatSync(path);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "trusted RPC state directory must be a real directory, not a symlink",
    );
  }

  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      "trusted RPC state directory must be owned by the current user",
    );
  }

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      "trusted RPC state directory permissions are too broad",
    );
  }
}

function assertSecureTokenFile(path: string): void {
  const stat = lstatSync(path);

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "trusted RPC token path must be a regular file, not a symlink",
    );
  }

  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      "trusted RPC token file must be owned by the current user",
    );
  }

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      "trusted RPC token file permissions are too broad",
    );
  }
}

function readValidatedToken(
  tokenPath: string,
  malformedMessage: string,
): string {
  assertSecureTokenFile(tokenPath);

  const existing = readFileSync(
    tokenPath,
    "utf8",
  ).trim();

  if (!TOKEN_REGEX.test(existing)) {
    throw new Error(malformedMessage);
  }

  chmodSync(tokenPath, 0o600);
  return existing;
}

export function ensureTrustedToken(
  dir: string,
  filename = "trusted-rpc.token",
): string {
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });

  assertSecureDirectory(dir);
  chmodSync(dir, 0o700);

  const tokenPath = join(dir, filename);

  try {
    return readValidatedToken(
      tokenPath,
      "trusted RPC token file is malformed; remove it and restart the native host",
    );
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  const token = randomBytes(32).toString("hex");
  const tempPath = join(
    dir,
    ".trusted-rpc.token.tmp." +
      randomBytes(8).toString("hex"),
  );

  writeFileSync(
    tempPath,
    token,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );

  try {
    linkSync(tempPath, tokenPath);
    unlinkSync(tempPath);
    return token;
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore temp cleanup failure
    }

    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      )
    ) {
      throw error;
    }

    return readValidatedToken(
      tokenPath,
      "trusted RPC token file is malformed after create race",
    );
  }
}
