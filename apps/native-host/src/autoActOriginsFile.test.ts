import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOACT_ORIGINS_FILENAME,
  bootstrapAutoActOrigins,
  readAutoActOriginsConfig,
} from "./autoActOriginsFile.js";

const dirs: string[] = [];
const posix = process.platform !== "win32";

function makeDir(): string {
  const dir = mkdtempSync(
    join(tmpdir(), "browser-agent-next-origins-"),
  );
  dirs.push(dir);
  if (posix) chmodSync(dir, 0o700);
  return dir;
}

function writeConfig(
  dir: string,
  content: unknown,
  mode = 0o644,
): string {
  const path = join(dir, AUTOACT_ORIGINS_FILENAME);
  writeFileSync(
    path,
    typeof content === "string"
      ? content
      : JSON.stringify(content),
    "utf8",
  );
  if (posix) chmodSync(path, mode);
  return path;
}

function config(origins: unknown[]): unknown {
  return { version: 1, origins };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readAutoActOriginsConfig", () => {
  it("文件不存在时返回 undefined", () => {
    expect(readAutoActOriginsConfig(makeDir())).toBeUndefined();
  });

  it("目录不存在时返回 undefined", () => {
    expect(
      readAutoActOriginsConfig(join(makeDir(), "missing")),
    ).toBeUndefined();
  });

  it("合法文件返回去重后的数组", () => {
    const dir = makeDir();
    writeConfig(
      dir,
      config([
        "http://127.0.0.1:4173",
        "https://example.com",
        "http://127.0.0.1:4173",
      ]),
    );

    expect(readAutoActOriginsConfig(dir)).toEqual([
      "http://127.0.0.1:4173",
      "https://example.com",
    ]);
  });

  it("0600 权限的文件同样合法", () => {
    const dir = makeDir();
    writeConfig(dir, config(["https://example.com"]), 0o600);

    expect(readAutoActOriginsConfig(dir)).toEqual([
      "https://example.com",
    ]);
  });

  it("空数组合法", () => {
    const dir = makeDir();
    writeConfig(dir, config([]));

    expect(readAutoActOriginsConfig(dir)).toEqual([]);
  });

  it("支持自定义文件名", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "custom.json"),
      JSON.stringify(config(["https://example.com"])),
      { mode: 0o644 },
    );
    if (posix) chmodSync(join(dir, "custom.json"), 0o644);

    expect(
      readAutoActOriginsConfig(dir, "custom.json"),
    ).toEqual(["https://example.com"]);
  });

  it("symlink 文件被拒绝", () => {
    const dir = makeDir();
    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify(config([])), "utf8");
    if (posix) chmodSync(real, 0o644);
    symlinkSync(real, join(dir, AUTOACT_ORIGINS_FILENAME));

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /regular file/,
    );
  });

  it("目标是目录而非普通文件时被拒绝", () => {
    const dir = makeDir();
    mkdirSync(join(dir, AUTOACT_ORIGINS_FILENAME));

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /regular file/,
    );
  });

  it.skipIf(!posix)("group 可写的文件被拒绝 (0o664)", () => {
    const dir = makeDir();
    writeConfig(dir, config([]), 0o664);

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /writable by group or others/,
    );
  });

  it.skipIf(!posix)("other 可写的文件被拒绝 (0o646)", () => {
    const dir = makeDir();
    writeConfig(dir, config([]), 0o646);

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /writable by group or others/,
    );
  });

  it.skipIf(!posix)("目录权限过宽时被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, config([]));
    chmodSync(dir, 0o755);

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /state directory permissions are too broad/,
    );
  });

  it("超过 64 KiB 被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, " ".repeat(64 * 1024 + 1));

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /exceeds/,
    );
  });

  it("非法 JSON 被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, "{not json");

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /not valid JSON/,
    );
  });

  it("顶层不是对象被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, "[]");

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /JSON object/,
    );
  });

  it("多出的 key 被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, {
      version: 1,
      origins: [],
      extra: true,
    });

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /exactly the keys/,
    );
  });

  it("缺少 key 被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, { version: 1 });

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /exactly the keys/,
    );
  });

  it("version 不为 1 被拒绝", () => {
    for (const version of [2, "1", 0, null]) {
      const dir = makeDir();
      writeConfig(dir, { version, origins: [] });

      expect(() => readAutoActOriginsConfig(dir)).toThrow(
        /version must be 1/,
      );
    }
  });

  it("origins 不是数组被拒绝", () => {
    const dir = makeDir();
    writeConfig(dir, {
      version: 1,
      origins: "https://example.com",
    });

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /must be an array/,
    );
  });

  it("恰好 100 条合法、超过 100 条被拒绝", () => {
    const okDir = makeDir();
    writeConfig(
      okDir,
      config(
        Array.from(
          { length: 100 },
          (_, i) => "https://h" + i + ".example.com",
        ),
      ),
    );
    expect(readAutoActOriginsConfig(okDir)).toHaveLength(100);

    const badDir = makeDir();
    writeConfig(
      badDir,
      config(
        Array.from(
          { length: 101 },
          (_, i) => "https://h" + i + ".example.com",
        ),
      ),
    );
    expect(() => readAutoActOriginsConfig(badDir)).toThrow(
      /more than 100/,
    );
  });

  it.each([
    ["path", "https://example.com/app"],
    ["尾部斜杠", "https://example.com/"],
    ["query", "https://example.com?x=1"],
    ["fragment", "https://example.com#frag"],
    ["credentials", "https://user:pw@example.com"],
    ["默认端口", "https://example.com:443"],
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
    ["非 URL", "not a url"],
    ["空字符串", ""],
    ["非字符串", 42],
    ["超长", "https://" + "a".repeat(2050) + ".com"],
  ])("非法 origin 条目被拒绝：%s", (_name, entry) => {
    const dir = makeDir();
    writeConfig(
      dir,
      config(["https://good.example.com", entry]),
    );

    expect(() => readAutoActOriginsConfig(dir)).toThrow(
      /entry 1/,
    );
  });
});

describe("bootstrapAutoActOrigins", () => {
  it("配置不存在时不调用 forward", async () => {
    const forward = vi.fn();
    const log = vi.fn();

    await bootstrapAutoActOrigins(
      () => undefined,
      forward,
      log,
    );

    expect(forward).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("读取抛错时不调用 forward 并记录日志", async () => {
    const forward = vi.fn();
    const log = vi.fn();

    await bootstrapAutoActOrigins(
      () => {
        throw new Error("bad config");
      },
      forward,
      log,
    );

    expect(forward).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(
      "auto-act origins config rejected: bad config",
    );
  });

  it("forward 失败只记录日志、不抛出", async () => {
    const log = vi.fn();

    await expect(
      bootstrapAutoActOrigins(
        () => ["https://example.com"],
        () => Promise.reject(new Error("timed out")),
        log,
      ),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("timed out");
  });

  it("扩展返回 ok=false 时只记录日志、不抛出", async () => {
    const log = vi.fn();

    await bootstrapAutoActOrigins(
      () => ["https://example.com"],
      () =>
        Promise.resolve({
          ok: false,
          error: { code: "BAD", message: "nope" },
        }),
      log,
    );

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("BAD: nope");
  });

  it("成功时发送正确的请求并只记录数量", async () => {
    const forward = vi.fn().mockResolvedValue({
      ok: true,
      result: { origins: [] },
    });
    const log = vi.fn();

    await bootstrapAutoActOrigins(
      () => ["https://example.com", "http://127.0.0.1:4173"],
      forward,
      log,
    );

    expect(forward).toHaveBeenCalledTimes(1);
    const request = forward.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      type: "policy.replace-autoact-origins",
      origins: ["https://example.com", "http://127.0.0.1:4173"],
    });
    expect(request.requestId).toMatch(
      /^native-autoact-bootstrap-.+/,
    );

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]?.[0] as string;
    expect(message).toContain("2");
    expect(message).not.toContain("example.com");
  });

  it("空数组也会下发（清空扩展 allowlist）", async () => {
    const forward = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { origins: [] } });

    await bootstrapAutoActOrigins(() => [], forward, vi.fn());

    expect(forward.mock.calls[0]?.[0]).toMatchObject({
      origins: [],
    });
  });
});
