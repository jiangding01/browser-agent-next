import { describe, expect, it } from "vitest";
import {
  STRICT_ACTION_KINDS,
  STRICT_KEYS,
  STRICT_VALUE_MAX_LENGTH,
} from "@browser-agent-next/core";
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
      "key",
      "kind",
      "label",
      "observedRevision",
      "ref",
      "tabId",
      "value",
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
      type: "string",
      enum: [...STRICT_ACTION_KINDS],
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
    expect(act.title).toBe("Act on an observed element");
  });

  it("browser.act 的 kind / key 枚举与 value / label 长度上限取自 core 常量（改常量即改 schema）", () => {
    const act = MODEL_FACING_MCP_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "browser.act",
    )!;

    expect(MODEL_INPUT_LIMITS.maxWriteValueLength).toBe(
      STRICT_VALUE_MAX_LENGTH,
    );
    expect(property(act.inputSchema, "kind").enum).toEqual([
      ...STRICT_ACTION_KINDS,
    ]);
    expect(STRICT_ACTION_KINDS).toEqual([
      "click",
      "setValue",
      "selectOption",
      "submit",
      "pressKey",
    ]);
    expect(property(act.inputSchema, "key")).toEqual({
      type: "string",
      enum: [...STRICT_KEYS],
    });
    // value 允许空串（清空字段），label 必须非空。
    expect(property(act.inputSchema, "value")).toEqual({
      type: "string",
      maxLength: STRICT_VALUE_MAX_LENGTH,
    });
    expect(property(act.inputSchema, "label")).toEqual({
      type: "string",
      minLength: 1,
      maxLength: STRICT_VALUE_MAX_LENGTH,
    });
    // schema 引用的不是 core 数组本身：deepFreeze 不会冻结 core 的常量。
    expect(property(act.inputSchema, "kind").enum).not.toBe(
      STRICT_ACTION_KINDS,
    );
    expect(Object.isFrozen(STRICT_KEYS)).toBe(false);

    // description 写明每种 kind 的字段、上限、审批与 includeValues 的影响。
    for (const fragment of [
      "setValue (requires value",
      "selectOption (requires label",
      "pressKey (requires key: one of " + STRICT_KEYS.join(", "),
      "at most " + STRICT_VALUE_MAX_LENGTH + " characters",
      "always require the operator to approve each action",
      "never echoes value, label or key",
      "field_value conditions are inconclusive",
    ]) {
      expect(act.description).toContain(fragment);
    }
    // 没有 oneOf / anyOf：部分 MCP 客户端不支持复合 schema。
    expect(act.inputSchema).not.toHaveProperty("oneOf");
    expect(act.inputSchema).not.toHaveProperty("anyOf");
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
    const { kind: _kind, ...rest } = validActInput;
    expect(parseModelActInput(validActInput)).toEqual({
      ...rest,
      action: { kind: "click" },
    });

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

  it.each([
    [{ kind: "click" }, { kind: "click" }],
    [
      { kind: "setValue", value: "hello 世界" },
      { kind: "setValue", value: "hello 世界" },
    ],
    // 空串表示清空字段。
    [{ kind: "setValue", value: "" }, { kind: "setValue", value: "" }],
    [
      {
        kind: "setValue",
        value: "x".repeat(STRICT_VALUE_MAX_LENGTH),
      },
      {
        kind: "setValue",
        value: "x".repeat(STRICT_VALUE_MAX_LENGTH),
      },
    ],
    [
      { kind: "selectOption", label: "Option B" },
      { kind: "selectOption", label: "Option B" },
    ],
    [{ kind: "submit" }, { kind: "submit" }],
    ...STRICT_KEYS.map((key) => [
      { kind: "pressKey", key },
      { kind: "pressKey", key },
    ]),
  ] as Array<[Record<string, unknown>, unknown]>)(
    "合法动作 %j 组装为 StrictActionArgs",
    (fields, action) => {
      const { kind: _kind, ...base } = validActInput;
      const parsed = parseModelActInput({ ...base, ...fields });

      expect(parsed.action).toEqual(action);
      expect(parsed).not.toHaveProperty("kind");
      expect(parsed).not.toHaveProperty("value");
      expect(parsed).not.toHaveProperty("label");
      expect(parsed).not.toHaveProperty("key");
    },
  );

  const CANARY = "CANARY-act-input-9f3c";

  it.each([
    ["click 带 value", { kind: "click", value: CANARY }],
    ["click 带 label", { kind: "click", label: CANARY }],
    ["click 带 key", { kind: "click", key: "Tab" }],
    ["setValue 缺 value", { kind: "setValue" }],
    ["setValue 带 label", { kind: "setValue", value: CANARY, label: CANARY }],
    ["setValue 的 value 不是字符串", { kind: "setValue", value: 1 }],
    [
      "setValue 超长",
      {
        kind: "setValue",
        value: CANARY + "x".repeat(STRICT_VALUE_MAX_LENGTH),
      },
    ],
    ["setValue 含换行", { kind: "setValue", value: CANARY + "\nnext" }],
    ["setValue 含制表符", { kind: "setValue", value: CANARY + "\t" }],
    ["setValue 含零宽字符", { kind: "setValue", value: CANARY + "\u200B" }],
    ["setValue 含 bidi 覆盖", { kind: "setValue", value: CANARY + "\u202E" }],
    ["setValue 含 NBSP", { kind: "setValue", value: CANARY + "\u00A0" }],
    ["setValue 含孤立代理项", { kind: "setValue", value: CANARY + "\uD800" }],
    ["selectOption 缺 label", { kind: "selectOption" }],
    ["selectOption 空 label", { kind: "selectOption", label: "" }],
    ["selectOption 带 value", { kind: "selectOption", label: CANARY, value: CANARY }],
    ["selectOption 带 key", { kind: "selectOption", label: CANARY, key: "Tab" }],
    ["selectOption 超长", { kind: "selectOption", label: CANARY + "x".repeat(STRICT_VALUE_MAX_LENGTH) }],
    ["submit 带 value", { kind: "submit", value: CANARY }],
    ["pressKey 缺 key", { kind: "pressKey" }],
    ["pressKey 未知 key（Enter）", { kind: "pressKey", key: "Enter" }],
    ["pressKey 未知 key（金丝雀）", { kind: "pressKey", key: CANARY }],
    ["pressKey 带 value", { kind: "pressKey", key: "Tab", value: CANARY }],
    ["未知 kind", { kind: CANARY }],
    ["kind 大小写不符", { kind: "CLICK" }],
    ["kind 缺失", { kind: undefined }],
    ["kind 不是字符串", { kind: 1 }],
    ["多余字段", { kind: "setValue", value: CANARY, text: CANARY }],
  ] as Array<[string, Record<string, unknown>]>)(
    "%s：POLICY_BLOCKED，错误消息为固定文本、不含参数",
    (_name, fields) => {
      const { kind: _kind, ...base } = validActInput;
      let caught: unknown;
      try {
        parseModelActInput({ ...base, ...fields });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "POLICY_BLOCKED",
        message:
          "browser.act rejected invalid or unbounded model input",
      });
      expect(JSON.stringify(caught)).not.toContain(CANARY);
      expect(String((caught as Error).stack)).not.toContain(CANARY);
    },
  );

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
