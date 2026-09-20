import {
  describe,
  expect,
  it,
} from "vitest";
import {
  MCP_CONFIG_ENV,
  loadModelFacingMcpConfig,
} from "./mcpConfig.js";

describe("loadModelFacingMcpConfig", () => {
  it("默认配置 fail closed：origin 为空、values 关闭，但安全工具目录可见", () => {
    const config =
      loadModelFacingMcpConfig({});

    expect(config.readOrigins)
      .toEqual([]);
    expect(
      config.navigationOrigins,
    ).toEqual([]);
    expect(config.tools).toEqual([
      "browser.open",
      "browser.observe",
      "browser.extract",
      "browser.verify",
      "browser.wait",
    ]);
    expect(config.includeValues)
      .toBe(false);
    expect(
      config.maxObservationElements,
    ).toBe(100);

    expect(
      Object.isFrozen(config),
    ).toBe(true);
    expect(
      Object.isFrozen(
        config.readOrigins,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(config.tools),
    ).toBe(true);
  });

  it("显式配置会 canonicalize origins 并按 allowlist 收窄工具", () => {
    const config =
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.readOrigins]:
          "https://b.test, https://a.test",
        [MCP_CONFIG_ENV
          .navigationOrigins]:
          "https://nav.test",
        [MCP_CONFIG_ENV.tools]:
          "browser.observe,browser.verify",
        [MCP_CONFIG_ENV.includeValues]:
          "true",
        [MCP_CONFIG_ENV
          .maxObservationElements]:
          "80",
        [MCP_CONFIG_ENV
          .maxVisibleRevisions]:
          "32",
        [MCP_CONFIG_ENV.rpcHost]:
          "LOCALHOST",
        [MCP_CONFIG_ENV.rpcPort]:
          "17367",
      });

    expect(config.readOrigins)
      .toEqual([
        "https://a.test",
        "https://b.test",
      ]);
    expect(
      config.navigationOrigins,
    ).toEqual([
      "https://nav.test",
    ]);
    expect(config.tools).toEqual([
      "browser.observe",
      "browser.verify",
    ]);
    expect(config.includeValues)
      .toBe(true);
    expect(
      config.maxObservationElements,
    ).toBe(80);
    expect(
      config.maxVisibleRevisions,
    ).toBe(32);
    expect(config.rpcHost)
      .toBe("localhost");
    expect(config.rpcPort)
      .toBe(17367);
  });

  it("拒绝 path origin、未知工具和非 loopback RPC host", () => {
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.readOrigins]:
            "https://example.test/path",
        }),
    ).toThrow(/origin-only/);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.tools]:
            "browser.observe,browser.act",
        }),
    ).toThrow(
      /unknown model-facing tool/,
    );

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.rpcHost]:
            "example.com",
        }),
    ).toThrow(/loopback/);
  });

  it("布尔值和所有资源上限使用严格解析", () => {
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.includeValues]:
            "1",
        }),
    ).toThrow(/true or false/);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV
            .maxObservationElements]:
            "501",
        }),
    ).toThrow(/between/);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.rpcPort]:
            "0",
        }),
    ).toThrow(/between/);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV
            .mcpMaxResultBytes]:
            String(1024 * 1024 + 1),
        }),
    ).toThrow(/between/);
  });

  it("token 只接受路径配置，不接受空路径或 NUL", () => {
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.rpcTokenPath]:
            " ",
        }),
    ).toThrow(/must not be empty/);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.rpcTokenPath]:
            "bad\0path",
        }),
    ).toThrow(/invalid/);
  });
});
