import type { ModelFacingToolName } from "@browser-agent-next/policy";
import { ModelToolExposurePolicy } from "@browser-agent-next/policy";
import { MODEL_INPUT_LIMITS } from "./modelToolInput.js";

export interface JsonSchema {
  readonly [key: string]: unknown;
}

export interface ModelFacingMcpTool {
  readonly name: ModelFacingToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

function stringSchema(
  maxLength: number = MODEL_INPUT_LIMITS.maxString,
): JsonSchema {
  return {
    type: "string",
    minLength: 1,
    maxLength,
  };
}

const TAB_ID_SCHEMA: JsonSchema = {
  type: "integer",
  minimum: 0,
};

const REF_SCHEMA = stringSchema(
  MODEL_INPUT_LIMITS.maxRefLength,
);

function boundedJsonValueSchema(depth = 0): JsonSchema {
  const scalarSchemas: JsonSchema[] = [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    {
      type: "string",
      maxLength: MODEL_INPUT_LIMITS.maxString,
    },
  ];

  if (depth >= 5) {
    return { oneOf: scalarSchemas };
  }

  return {
    oneOf: [
      ...scalarSchemas,
      {
        type: "array",
        maxItems: 50,
        items: boundedJsonValueSchema(depth + 1),
      },
      {
        type: "object",
        maxProperties: 50,
        propertyNames: { maxLength: 128 },
        additionalProperties:
          boundedJsonValueSchema(depth + 1),
      },
    ],
  };
}

const OBSERVE_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: {
      type: "string",
      enum: ["dom", "hybrid"],
    },
    maxElements: {
      type: "integer",
      minimum: 1,
      maximum: MODEL_INPUT_LIMITS.maxObserveElements,
    },
    maxAxElements: {
      type: "integer",
      minimum: 1,
      maximum: MODEL_INPUT_LIMITS.maxObserveElements,
    },
    includeValues: { type: "boolean" },
    includeOpenShadowRoots: { type: "boolean" },
  },
};

function typedConditionSchema(
  type: string,
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: type },
      ...properties,
    },
    required: ["type", ...required],
  };
}

const VERIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "conditions"],
  properties: {
    mode: {
      type: "string",
      enum: ["all", "any"],
    },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: MODEL_INPUT_LIMITS.maxVerifyConditions,
      items: {
        oneOf: [
          typedConditionSchema(
            "url_matches",
            { pattern: stringSchema() },
            ["pattern"],
          ),
          typedConditionSchema(
            "title_matches",
            { pattern: stringSchema() },
            ["pattern"],
          ),
          typedConditionSchema(
            "ref_exists",
            { ref: REF_SCHEMA },
            ["ref"],
          ),
          typedConditionSchema(
            "ref_visible",
            { ref: REF_SCHEMA },
            ["ref"],
          ),
          typedConditionSchema(
            "ref_absent",
            { ref: REF_SCHEMA },
            ["ref"],
          ),
          typedConditionSchema(
            "text_present",
            {
              text: stringSchema(),
              scopeRef: REF_SCHEMA,
            },
            ["text"],
          ),
          typedConditionSchema(
            "field_value",
            {
              ref: REF_SCHEMA,
              equals: boundedJsonValueSchema(),
            },
            ["ref", "equals"],
          ),
          typedConditionSchema(
            "dialog_present",
            {
              title: {
                type: "string",
                maxLength: MODEL_INPUT_LIMITS.maxString,
              },
            },
            [],
          ),
          typedConditionSchema(
            "download_started",
            {
              filenamePattern: {
                type: "string",
                maxLength: MODEL_INPUT_LIMITS.maxString,
              },
            },
            [],
          ),
          typedConditionSchema(
            "network_request_completed",
            { urlPattern: stringSchema() },
            ["urlPattern"],
          ),
        ],
      },
    },
  },
};

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

const DEFINITIONS: readonly ModelFacingMcpTool[] = [
  {
    name: "browser.open",
    title: "Open browser tab",
    description:
      "Open a new Agent-owned HTTP(S) tab. Navigation is independently restricted by the model navigation origin policy.",
    inputSchema: objectSchema(
      {
        url: stringSchema(),
        active: { type: "boolean" },
      },
      ["url"],
    ),
  },
  {
    name: "browser.observe",
    title: "Observe browser state",
    description:
      "Return a bounded, policy-projected browser observation. Values and cross-origin frame content may be redacted by model-egress policy.",
    inputSchema: objectSchema(
      {
        tabId: TAB_ID_SCHEMA,
        sinceRevision: REF_SCHEMA,
        options: OBSERVE_OPTIONS_SCHEMA,
      },
      ["tabId"],
    ),
  },
  {
    name: "browser.extract",
    title: "Extract observed elements",
    description:
      "Project elements from a revision that was already exposed to the model. This never reads an internal-only Runtime revision.",
    inputSchema: objectSchema(
      {
        tabId: TAB_ID_SCHEMA,
        observedRevision: REF_SCHEMA,
        refs: {
          type: "array",
          minItems: 1,
          maxItems: MODEL_INPUT_LIMITS.maxRefs,
          items: REF_SCHEMA,
        },
        maxItems: {
          type: "integer",
          minimum: 1,
          maximum: MODEL_INPUT_LIMITS.maxRefs,
        },
      },
      ["tabId", "observedRevision"],
    ),
  },
  {
    name: "browser.verify",
    title: "Verify observed browser state",
    description:
      "Verify conditions against a model-visible retained observation. Verification does not query hidden Runtime state.",
    inputSchema: objectSchema(
      {
        tabId: TAB_ID_SCHEMA,
        observedRevision: REF_SCHEMA,
        verification: VERIFICATION_SCHEMA,
      },
      ["tabId", "observedRevision", "verification"],
    ),
  },
  {
    name: "browser.wait",
    title: "Wait for browser condition",
    description:
      "Repeatedly obtain fresh policy-projected observations and verify conditions within bounded timeout and polling limits.",
    inputSchema: objectSchema(
      {
        tabId: TAB_ID_SCHEMA,
        verification: VERIFICATION_SCHEMA,
        timeoutMs: {
          type: "number",
          minimum: 0,
          maximum: MODEL_INPUT_LIMITS.maxWaitMs,
        },
        pollIntervalMs: {
          type: "integer",
          minimum: MODEL_INPUT_LIMITS.minPollMs,
          maximum: MODEL_INPUT_LIMITS.maxPollMs,
        },
        options: OBSERVE_OPTIONS_SCHEMA,
      },
      ["tabId", "verification"],
    ),
  },
];

function deepFreeze<T>(value: T): T {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(
    value as Record<string, unknown>,
  )) {
    deepFreeze(child);
  }
  return value;
}

export const MODEL_FACING_MCP_TOOL_DEFINITIONS =
  deepFreeze(DEFINITIONS);

/**
 * 根据显式 exposure policy 构建真正对 MCP client 可见的 tool catalog。
 *
 * catalog 本身没有“发现内部 RPC 并自动注册”的路径；未来新增 trusted
 * control-plane 方法不会自动进入这里。
 */
export function createModelFacingMcpToolCatalog(
  policy: ModelToolExposurePolicy,
): readonly ModelFacingMcpTool[] {
  return MODEL_FACING_MCP_TOOL_DEFINITIONS.filter(
    (tool) => policy.isExposed(tool.name),
  );
}
