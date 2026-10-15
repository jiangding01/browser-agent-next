import { describe, expect, it } from "vitest";
import {
  MODEL_FACING_DEFAULT_TOOL_NAMES,
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  MODEL_INPUT_LIMITS,
  parseModelActInput,
  parseModelExtractInput,
  parseModelObserveInput,
  parseModelOpenInput,
  parseModelVerifyInput,
  parseModelWaitInput,
} from "./modelToolInput.js";
import {
  MODEL_FACING_MCP_TOOL_DEFINITIONS,
  createModelFacingMcpToolCatalog,
  type JsonSchema,
} from "./modelToolCatalog.js";

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function property(
  schema: JsonSchema,
  name: string,
): Record<string, unknown> {
  const properties = record(schema.properties);
  return record(properties[name]);
}

const representativeInputs: Record<
  ModelFacingToolName,
  unknown
> = {
  "browser.open": {
    url: "https://example.test/start",
    active: false,
  },
  "browser.observe": {
    tabId: 7,
    sinceRevision: "rev-1",
    options: {
      profile: "hybrid",
      maxElements: MODEL_INPUT_LIMITS.maxObserveElements,
      maxAxElements: MODEL_INPUT_LIMITS.maxObserveElements,
      includeValues: false,
      includeOpenShadowRoots: true,
    },
  },
  "browser.extract": {
    tabId: 7,
    observedRevision: "rev-1",
    refs: ["@save"],
    maxItems: MODEL_INPUT_LIMITS.maxRefs,
  },
  "browser.verify": {
    tabId: 7,
    observedRevision: "rev-1",
    verification: {
      mode: "all",
      conditions: [
        { type: "ref_visible", ref: "@save" },
      ],
    },
  },
  "browser.wait": {
    tabId: 7,
    timeoutMs: MODEL_INPUT_LIMITS.maxWaitMs,
    pollIntervalMs: MODEL_INPUT_LIMITS.minPollMs,
    verification: {
      mode: "all",
      conditions: [
        { type: "text_present", text: "Done" },
      ],
    },
  },
  "browser.act": {
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@save",
    kind: "click",
    verifyTimeoutMs: MODEL_INPUT_LIMITS.maxActVerifyTimeoutMs,
    verification: {
      mode: "any",
      conditions: [
        { type: "text_present", text: "Saved" },
      ],
    },
  },
};

const validActInput = representativeInputs[
  "browser.act"
] as Record<string, unknown>;

function parseRepresentative(
  tool: ModelFacingToolName,
  input: unknown,
): void {
  switch (tool) {
    case "browser.open":
      parseModelOpenInput(input);
      return;
    case "browser.observe":
      parseModelObserveInput(input);
      return;
    case "browser.extract":
      parseModelExtractInput(input);
      return;
    case "browser.verify":
      parseModelVerifyInput(input);
      return;
    case "browser.wait":
      parseModelWaitInput(input);
      return;
    case "browser.act":
      parseModelActInput(input);
      return;
  }
}

describe("model-facing MCP tool catalog", () => {
  it("只包含显式允许的六个模型工具，且不包含控制面工具", () => {
    expect(
      MODEL_FACING_MCP_TOOL_DEFINITIONS.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "browser.open",
      "browser.observe",
      "browser.extract",
      "browser.verify",
      "browser.wait",
      "browser.act",
    ]);

    expect(
      MODEL_FACING_MCP_TOOL_DEFINITIONS.some(
        (tool) =>
          String(tool.name).startsWith("authorization.") ||
          String(tool.name).startsWith("policy.") ||
          String(tool.name).startsWith("execution."),
      ),
    ).toBe(false);
  });

  it("默认暴露集合下 catalog 不含 side-effect 的 browser.act，显式暴露后才出现", () => {
    expect(
      createModelFacingMcpToolCatalog(
        new ModelToolExposurePolicy(
          MODEL_FACING_DEFAULT_TOOL_NAMES,
        ),
      ).map((tool) => tool.name),
    ).not.toContain("browser.act");

    expect(
      createModelFacingMcpToolCatalog(
        new ModelToolExposurePolicy([
          "browser.observe",
          "browser.act",
        ]),
      ).map((tool) => tool.name),
    ).toEqual(["browser.observe", "browser.act"]);
  });

  it("browser.act schema 精确封闭，bounds 引用 MODEL_INPUT_LIMITS", () => {
    const act = MODEL_FACING_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "browser.act",
    )!;

    expect(act.inputSchema.additionalProperties).toBe(false);
    expect(
      Object.keys(record(act.inputSchema.properties)).sort(),
    ).toEqual([
      "kind",
      "observedRevision",
      "ref",
      "tabId",
      "verification",
      "verifyTimeoutMs",
    ]);
    expect(act.inputSchema.required).toEqual([
      "tabId",
      "observedRevision",
      "ref",
      "kind",
      "verification",
    ]);
    expect(property(act.inputSchema, "kind")).toEqual({
      const: "click",
    });
    expect(
      property(act.inputSchema, "ref").maxLength,
    ).toBe(MODEL_INPUT_LIMITS.maxRefLength);
    expect(
      property(act.inputSchema, "verifyTimeoutMs"),
    ).toMatchObject({
      minimum: 0,
      maximum: MODEL_INPUT_LIMITS.maxActVerifyTimeoutMs,
    });
    expect(
      property(act.inputSchema, "verification")
        .additionalProperties,
    ).toBe(false);
    expect(act.description).toContain("Side-effect");
  });

  it("catalog 继续由 ModelToolExposurePolicy 做最终过滤", () => {
    const policy = new ModelToolExposurePolicy([
      "browser.observe",
      "browser.verify",
    ]);

    expect(
      createModelFacingMcpToolCatalog(policy).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "browser.observe",
      "browser.verify",
    ]);
  });

  it("schema bounds 与 runtime validator 共用 MODEL_INPUT_LIMITS", () => {
    const observe = MODEL_FACING_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "browser.observe",
    )!;
    const observeOptions = property(
      observe.inputSchema,
      "options",
    );
    expect(
      property(observeOptions, "maxElements").maximum,
    ).toBe(MODEL_INPUT_LIMITS.maxObserveElements);
    expect(
      property(observeOptions, "maxAxElements").maximum,
    ).toBe(MODEL_INPUT_LIMITS.maxObserveElements);

    const extract = MODEL_FACING_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "browser.extract",
    )!;
    expect(
      property(extract.inputSchema, "maxItems").maximum,
    ).toBe(MODEL_INPUT_LIMITS.maxRefs);

    const wait = MODEL_FACING_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "browser.wait",
    )!;
    expect(
      property(wait.inputSchema, "timeoutMs").maximum,
    ).toBe(MODEL_INPUT_LIMITS.maxWaitMs);
    expect(
      property(wait.inputSchema, "pollIntervalMs").minimum,
    ).toBe(MODEL_INPUT_LIMITS.minPollMs);
    expect(
      property(wait.inputSchema, "pollIntervalMs").maximum,
    ).toBe(MODEL_INPUT_LIMITS.maxPollMs);
  });

  it("catalog 中每个工具的代表性输入都能通过同一 runtime validator", () => {
    for (const tool of MODEL_FACING_MCP_TOOL_DEFINITIONS) {
      expect(() =>
        parseRepresentative(
          tool.name,
          representativeInputs[tool.name],
        )
      ).not.toThrow();
    }
  });

  it("definitions 与嵌套 schema 在运行时被冻结，避免 transport 层修改安全契约", () => {
    expect(
      Object.isFrozen(MODEL_FACING_MCP_TOOL_DEFINITIONS),
    ).toBe(true);
    expect(
      Object.isFrozen(
        MODEL_FACING_MCP_TOOL_DEFINITIONS[0]?.inputSchema,
      ),
    ).toBe(true);
  });
});

describe("parseModelActInput", () => {
  it("接受精确字段集合并只返回已知字段", () => {
    expect(parseModelActInput(validActInput)).toEqual(
      validActInput,
    );

    const { verifyTimeoutMs: _timeout, ...withoutTimeout } =
      validActInput;
    expect(parseModelActInput(withoutTimeout)).not.toHaveProperty(
      "verifyTimeoutMs",
    );
  });

  it.each([
    "authorizationId",
    "assurance",
    "source",
    "actionId",
    "ownedBySession",
    "ttlMs",
  ])("模型传入授权/执行身份字段 %s 一律 POLICY_BLOCKED", (key) => {
    expect(() =>
      parseModelActInput({
        ...validActInput,
        [key]: key === "assurance"
          ? "operator-approved"
          : "model-supplied",
      })
    ).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" }),
    );
  });

  it("kind 必须是 click", () => {
    for (const kind of ["setValue", "CLICK", undefined, 1]) {
      expect(() =>
        parseModelActInput({ ...validActInput, kind })
      ).toThrow(
        expect.objectContaining({ code: "POLICY_BLOCKED" }),
      );
    }
  });

  it("verifyTimeoutMs 必须在 0..5000，ref/revision/verification 必须有界且合法", () => {
    expect(() =>
      parseModelActInput({ ...validActInput, verifyTimeoutMs: 0 })
    ).not.toThrow();

    const invalid: Array<Record<string, unknown>> = [
      { verifyTimeoutMs: -1 },
      { verifyTimeoutMs: 5_001 },
      { verifyTimeoutMs: Number.POSITIVE_INFINITY },
      { verifyTimeoutMs: "100" },
      { tabId: -1 },
      { tabId: 1.5 },
      { ref: "" },
      { ref: "x".repeat(MODEL_INPUT_LIMITS.maxRefLength + 1) },
      { observedRevision: "" },
      { verification: { mode: "all", conditions: [] } },
      {
        verification: {
          mode: "all",
          conditions: [{ type: "text_present", text: "x", extra: 1 }],
        },
      },
    ];
    for (const patch of invalid) {
      expect(() =>
        parseModelActInput({ ...validActInput, ...patch })
      ).toThrow(
        expect.objectContaining({ code: "POLICY_BLOCKED" }),
      );
    }

    expect(() => parseModelActInput(null)).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" }),
    );
    expect(() => parseModelActInput([validActInput])).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" }),
    );
  });
});
