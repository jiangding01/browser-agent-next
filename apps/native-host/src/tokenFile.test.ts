import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureTrustedToken,
  TOKEN_REGEX,
} from "./tokenFile.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
});

describe("ensureTrustedToken", () => {
  it("创建并稳定复用 0600 trusted token", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "browser-agent-next-token-"),
    );
    dirs.push(dir);

    const first = ensureTrustedToken(dir);
    const second = ensureTrustedToken(dir);

    expect(first).toBe(second);
    expect(first).toMatch(TOKEN_REGEX);

    const path = join(dir, "trusted-rpc.token");
    expect(readFileSync(path, "utf8")).toBe(first);

    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("已有 malformed token 时 fail closed", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "browser-agent-next-token-"),
    );
    dirs.push(dir);

    const path = join(dir, "trusted-rpc.token");
    writeFileSync(path, "bad-token", "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o600);

    expect(() => ensureTrustedToken(dir)).toThrow(
      /malformed/,
    );
  });

  it("已有 state directory 权限过宽时 fail closed", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(
      join(tmpdir(), "browser-agent-next-token-"),
    );
    dirs.push(dir);
    chmodSync(dir, 0o755);

    expect(() => ensureTrustedToken(dir)).toThrow(
      /state directory permissions are too broad/,
    );
  });

  it("已有 token 权限过宽时 fail closed", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(
      join(tmpdir(), "browser-agent-next-token-"),
    );
    dirs.push(dir);
    const path = join(dir, "trusted-rpc.token");
    writeFileSync(path, "a".repeat(64), "utf8");
    chmodSync(path, 0o644);

    expect(() => ensureTrustedToken(dir)).toThrow(
      /token file permissions are too broad/,
    );
  });

  it("拒绝把 trusted token 路径指向符号链接", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(
      join(tmpdir(), "browser-agent-next-token-"),
    );
    dirs.push(dir);

    const target = join(dir, "target.txt");
    writeFileSync(
      target,
      "a".repeat(64),
      "utf8",
    );
    symlinkSync(
      target,
      join(dir, "trusted-rpc.token"),
    );

    expect(() => ensureTrustedToken(dir)).toThrow(
      /regular file|symlink/,
    );
  });
});
