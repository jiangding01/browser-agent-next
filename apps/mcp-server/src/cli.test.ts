import {
  describe,
  expect,
  it,
} from "vitest";
import {
  createModelFacingInvoker,
} from "./cli.js";
import {
  MCP_CONFIG_ENV,
  loadModelFacingMcpConfig,
} from "./mcpConfig.js";

const TOKEN = "b".repeat(64);

describe("MCP CLI assembly", () => {
  it("每次 factory 组装独立 adapter，并严格继承 operator tool allowlist", () => {
    const config =
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.readOrigins]:
          "https://allowed.test",
        [MCP_CONFIG_ENV
          .navigationOrigins]:
          "https://allowed.test",
        [MCP_CONFIG_ENV.tools]:
          "browser.observe,browser.extract,browser.verify",
      });

    const first =
      createModelFacingInvoker(
        config,
        TOKEN,
      );
    const second =
      createModelFacingInvoker(
        config,
        TOKEN,
      );

    expect(first).not.toBe(second);
    expect(first.exposedTools())
      .toEqual([
        "browser.observe",
        "browser.extract",
        "browser.verify",
      ]);
    expect(second.exposedTools())
      .toEqual(first.exposedTools());
  });

  it("默认配置不会因为 CLI 组装而隐式添加 origin", () => {
    const config =
      loadModelFacingMcpConfig({});

    expect(config.readOrigins)
      .toEqual([]);
    expect(
      config.navigationOrigins,
    ).toEqual([]);

    const adapter =
      createModelFacingInvoker(
        config,
        TOKEN,
      );

    expect(adapter.exposedTools())
      .toEqual([
        "browser.open",
        "browser.observe",
        "browser.extract",
        "browser.verify",
        "browser.wait",
      ]);
  });
});
