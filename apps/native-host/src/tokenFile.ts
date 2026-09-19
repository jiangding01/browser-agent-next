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

export function ensureTrustedToken(
  dir: string,
  filename = "trusted-rpc.token",
): string {
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });

  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(
      "trusted RPC state directory must be a real directory, not a symlink",
    );
  }
  chmodSync(dir, 0o700);

  const tokenPath = join(dir, filename);

  try {
    const tokenStat = lstatSync(tokenPath);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) {
      throw new Error(
        "trusted RPC token path must be a regular file, not a symlink",
      );
    }

    if (
      typeof process.getuid === "function" &&
      tokenStat.uid !== process.getuid()
    ) {
      throw new Error(
        "trusted RPC token file must be owned by the current user",
      );
    }

    const tokenStat = lstatSync(tokenPath);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) {
      throw new Error(
        "trusted RPC token path must be a regular file after create race",
      );
    }

    const existing = readFileSync(
      tokenPath,
      "utf8",
    ).trim();

    if (!TOKEN_REGEX.test(existing)) {
      throw new Error(
        "trusted RPC token file is malformed; remove it and restart the native host",
      );
    }

    chmodSync(tokenPath, 0o600);
    return existing;
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

    const existing = readFileSync(
      tokenPath,
      "utf8",
    ).trim();

    if (!TOKEN_REGEX.test(existing)) {
      throw new Error(
        "trusted RPC token file is malformed after create race",
      );
    }

    chmodSync(tokenPath, 0o600);
    return existing;
  }
}
