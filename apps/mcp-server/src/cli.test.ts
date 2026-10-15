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

  it("显式暴露 browser.act 时为每个连接注入 act broker", async () => {
    const config =
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.readOrigins]:
          "https://allowed.test",
        [MCP_CONFIG_ENV.actOrigins]:
          "https://allowed.test",
        [MCP_CONFIG_ENV.tools]:
          "browser.observe,browser.act",
      });

    const adapter =
      createModelFacingInvoker(
        config,
        TOKEN,
      );

    expect(adapter.exposedTools())
      .toEqual([
        "browser.observe",
        "browser.act",
      ]);
    // broker 已注入：越过“未配置 broker”检查，停在本连接未出境的 revision 上。
    await expect(
      adapter.invoke("browser.act", {
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@save",
        kind: "click",
        verification: {
          mode: "all",
          conditions: [
            {
              type: "text_present",
              text: "Saved",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "MODEL_EGRESS_BLOCKED",
    });
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
