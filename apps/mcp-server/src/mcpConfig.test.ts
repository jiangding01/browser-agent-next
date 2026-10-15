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
    expect(config.tools).not.toContain(
      "browser.act",
    );
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
            "browser.observe,browser.click",
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

  it("MODEL_TOOLS 为空字符串时同样使用不含 browser.act 的默认集合", () => {
    for (const value of ["", "  "]) {
      const config =
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.tools]: value,
        });

      expect(config.tools).toEqual([
        "browser.open",
        "browser.observe",
        "browser.extract",
        "browser.verify",
        "browser.wait",
      ]);
    }
  });

  it("显式写 browser.act 才会暴露 side-effect 工具", () => {
    const config =
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.tools]:
          "browser.observe,browser.act",
      });

    expect(config.tools).toEqual([
      "browser.observe",
      "browser.act",
    ]);
  });

  it("act 配置默认 fail closed：origin 为空、预算 16、operator 审批、超时 60s", () => {
    const config =
      loadModelFacingMcpConfig({});

    expect(config.actOrigins)
      .toEqual([]);
    expect(
      Object.isFrozen(
        config.actOrigins,
      ),
    ).toBe(true);
    expect(config.actBudget)
      .toBe(16);
    expect(config.actApproval)
      .toBe("operator");
    expect(
      config.approvalTimeoutMs,
    ).toBe(60_000);
  });

  it("ACT_ORIGINS 使用 exact-origin 规则 canonicalize 且必须是 READ_ORIGINS 子集", () => {
    const config =
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.readOrigins]:
          "https://b.test, https://a.test:8443, https://c.test",
        [MCP_CONFIG_ENV.actOrigins]:
          "https://b.test/, HTTPS://A.test:8443, https://b.test",
      });

    expect(config.actOrigins)
      .toEqual([
        "https://a.test:8443",
        "https://b.test",
      ]);

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.readOrigins]:
            "https://a.test",
          [MCP_CONFIG_ENV.actOrigins]:
            "https://a.test,https://b.test",
        }),
    ).toThrow(/subset/);

    // act 不能绕过 read plane：READ_ORIGINS 为空时任何 act origin 都无效。
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.actOrigins]:
            "https://a.test",
        }),
    ).toThrow(/subset/);

    // 子集比较按 origin 精确匹配，端口不同即不同 origin。
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.readOrigins]:
            "https://a.test",
          [MCP_CONFIG_ENV.actOrigins]:
            "https://a.test:8443",
        }),
    ).toThrow(/subset/);
  });

  it("ACT_ORIGINS 拒绝 path、query、fragment、credentials 与非 http(s)，且条数有上限", () => {
    const readOrigins =
      "https://a.test";

    for (const bad of [
      "https://a.test/path",
      "https://a.test?x=1",
      "https://a.test/#frag",
      "https://user:pass@a.test",
      "ftp://a.test",
      "not-a-url",
      "*.a.test",
    ]) {
      expect(
        () =>
          loadModelFacingMcpConfig({
            [MCP_CONFIG_ENV
              .readOrigins]:
              readOrigins,
            [MCP_CONFIG_ENV
              .actOrigins]: bad,
          }),
      ).toThrow();
    }

    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.readOrigins]:
            readOrigins,
          [MCP_CONFIG_ENV.actOrigins]:
            "https://a.test,,https://a.test",
        }),
    ).toThrow(/invalid or unbounded/);

    const tooMany = Array.from(
      { length: 101 },
      (_, index) =>
        "https://h" +
        index +
        ".test",
    ).join(",");
    expect(
      () =>
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.readOrigins]:
            tooMany,
          [MCP_CONFIG_ENV.actOrigins]:
            tooMany,
        }),
    ).toThrow(/invalid or unbounded/);
  });

  it("ACT_BUDGET 接受 1..256 整数并拒绝越界与非整数", () => {
    for (const [value, expected] of [
      ["1", 1],
      ["256", 256],
    ] as const) {
      expect(
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV.actBudget]:
            value,
        }).actBudget,
      ).toBe(expected);
    }

    for (const bad of [
      "0",
      "257",
      "-1",
      "1.5",
      "abc",
      "1e2",
    ]) {
      expect(
        () =>
          loadModelFacingMcpConfig({
            [MCP_CONFIG_ENV.actBudget]:
              bad,
          }),
      ).toThrow(
        /must be (an integer|between)/,
      );
    }
  });

  it("ACT_APPROVAL 只接受 operator 与 agent-owned-auto", () => {
    expect(
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.actApproval]:
          "agent-owned-auto",
      }).actApproval,
    ).toBe("agent-owned-auto");

    expect(
      loadModelFacingMcpConfig({
        [MCP_CONFIG_ENV.actApproval]:
          "operator",
      }).actApproval,
    ).toBe("operator");

    for (const bad of [
      "auto",
      "Operator",
      " operator",
      "agent-owned-auto ",
      "true",
    ]) {
      expect(
        () =>
          loadModelFacingMcpConfig({
            [MCP_CONFIG_ENV
              .actApproval]: bad,
          }),
      ).toThrow(
        /operator or agent-owned-auto/,
      );
    }
  });

  it("APPROVAL_TIMEOUT_MS 接受 1..120000 整数并拒绝越界与非整数", () => {
    for (const [value, expected] of [
      ["1", 1],
      ["120000", 120_000],
    ] as const) {
      expect(
        loadModelFacingMcpConfig({
          [MCP_CONFIG_ENV
            .approvalTimeoutMs]:
            value,
        }).approvalTimeoutMs,
      ).toBe(expected);
    }

    for (const bad of [
      "0",
      "120001",
      "-5",
      "1.5",
      "soon",
    ]) {
      expect(
        () =>
          loadModelFacingMcpConfig({
            [MCP_CONFIG_ENV
              .approvalTimeoutMs]: bad,
          }),
      ).toThrow(
        /must be (an integer|between)/,
      );
    }
  });
});
