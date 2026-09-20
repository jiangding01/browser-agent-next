import { describe, expect, it } from "vitest";
import {
  ModelToolExposurePolicy,
  type ModelFacingToolName,
} from "@browser-agent-next/policy";
import {
  MODEL_INPUT_LIMITS,
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
};

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
  }
}

describe("model-facing MCP tool catalog", () => {
  it("只包含显式允许的五个模型工具，且不包含副作用/控制面工具", () => {
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
    ]);

    expect(
      MODEL_FACING_MCP_TOOL_DEFINITIONS.some(
        (tool) => tool.name === ("browser.act" as ModelFacingToolName),
      ),
    ).toBe(false);
    expect(
      MODEL_FACING_MCP_TOOL_DEFINITIONS.some(
        (tool) =>
          String(tool.name).startsWith("authorization.") ||
          String(tool.name).startsWith("policy.") ||
          String(tool.name).startsWith("execution."),
      ),
    ).toBe(false);
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
