import type {
  CoverageState,
  ElementCapability,
  ElementState,
} from "@browser-agent-next/core";
import type { PerceptionSourceResult } from "@browser-agent-next/perception";
import type { ChromeDebuggerReadTransport } from "../chrome/chromeDebuggerTransport.js";
import type { ExactFrameMapping } from "./frameCorrespondence.js";

interface AXValue {
  value?: unknown;
}

interface AXProperty {
  name: string;
  value?: AXValue;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  backendDOMNodeId?: number;
}

interface PageFrame {
  id: string;
  url: string;
}

interface PageFrameTree {
  frame: PageFrame;
  childFrames?: PageFrameTree[];
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

const FIELD_ROLES = new Set([
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
]);

export interface CollectedAxSource extends PerceptionSourceResult {
  cdpFrameIdByFrame: Record<string, string>;
  mainCdpFrameId?: string;
}

export interface CollectMainAxSourceInput {
  tabId: number;
  mainDocumentEpoch: string;
  transport: ChromeDebuggerReadTransport;
  maxElements?: number;
  hasChildFrames?: boolean;
}

export interface CollectMappedAxSourceInput {
  tabId: number;
  mappings: ExactFrameMapping[];
  expectedFrameIds: string[];
  transport: ChromeDebuggerReadTransport;
  maxElements?: number;
}

function axString(value: AXValue | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function property(
  node: AXNode,
  name: string,
): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function booleanProperty(
  node: AXNode,
  name: string,
): boolean | undefined {
  const value = property(node, name);
  return typeof value === "boolean" ? value : undefined;
}

function normalizedRole(node: AXNode): string {
  return axString(node.role).trim().toLowerCase();
}

function capabilitiesFor(role: string): ElementCapability[] {
  switch (role) {
    case "button":
    case "link":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "tab":
    case "treeitem":
    case "option":
      return [{ kind: "click" }];

    case "checkbox":
    case "radio":
    case "switch":
      return [{ kind: "click" }, { kind: "check" }];

    case "textbox":
    case "searchbox":
    case "spinbutton":
      return [
        { kind: "setValue", valueType: "text" },
        { kind: "focus" },
      ];

    case "combobox":
    case "listbox":
      return [{ kind: "selectOption" }, { kind: "focus" }];

    case "slider":
      return [{ kind: "focus" }];

    default:
      return [];
  }
}

function stateFor(node: AXNode): ElementState["state"] {
  const disabled = booleanProperty(node, "disabled");
  const focused = booleanProperty(node, "focused");
  const selected = booleanProperty(node, "selected");
  const expanded = booleanProperty(node, "expanded");
  const required = booleanProperty(node, "required");
  const readonly = booleanProperty(node, "readonly");
  const checkedRaw = property(node, "checked");

  const checked =
    checkedRaw === "mixed"
      ? "mixed"
      : typeof checkedRaw === "boolean"
        ? checkedRaw
        : undefined;

  return {
    visible: true,
    enabled: disabled !== true,
    focused: focused === true,
    ...(selected !== undefined ? { selected } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(readonly !== undefined ? { readonly } : {}),
    ...(checked !== undefined ? { checked } : {}),
  };
}

function valueFor(node: AXNode): ElementState["value"] | undefined {
  const value = node.value?.value;

  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return { kind: "boolean", display: value };
  }
  if (typeof value === "number") {
    return { kind: "number", display: value };
  }
  return { kind: "text", display: value };
}

function aggregateCoverage(input: {
  returned: number;
  totalKnown: number;
  truncated: boolean;
  missingFrameCount: number;
  failedFrameCount: number;
}): CoverageState {
  if (input.missingFrameCount > 0 || input.failedFrameCount > 0) {
    return {
      status: "partial",
      returned: input.returned,
      reason: input.missingFrameCount > 0
        ? "one-or-more-frames-unmapped"
        : "one-or-more-frames-failed",
    };
  }

  return {
    status: input.truncated ? "truncated" : "complete",
    returned: input.returned,
    totalKnown: input.totalKnown,
    ...(input.truncated ? { reason: "ax-output-cap" } : {}),
  };
}

function toCandidate(
  tabId: number,
  mapping: ExactFrameMapping,
  node: AXNode,
) {
  const role = normalizedRole(node);
  const name = axString(node.name).replace(/\s+/g, " ").trim();
  const value = valueFor(node);

  return {
    source: "ax" as const,
    identity: {
      source: "ax" as const,
      tabId,
      cdpFrameId: mapping.cdpFrameId,
      documentEpoch: mapping.documentEpoch,
      backendNodeId: node.backendDOMNodeId!,
    },
    kind: FIELD_ROLES.has(role) ? "field" as const : "element" as const,
    semantic: {
      role,
      ...(name ? { name } : {}),
    },
    state: stateFor(node),
    ...(value !== undefined ? { value } : {}),
    frameId: mapping.webFrameId,
    capabilities: capabilitiesFor(role),
  };
}

export async function collectMappedAxSource(
  input: CollectMappedAxSourceInput,
): Promise<CollectedAxSource> {
  const maxElements = input.maxElements ?? 500;

  if (!Number.isInteger(maxElements) || maxElements < 1) {
    throw new Error("maxElements must be a positive integer");
  }

  const mappedWebFrames = new Set(
    input.mappings.map((mapping) => mapping.webFrameId),
  );
  const missingFrameIds = input.expectedFrameIds.filter(
    (frameId) => !mappedWebFrames.has(frameId),
  );

  const settled = await Promise.all(
    input.mappings.map(async (mapping) => {
      try {
        const result = await input.transport.send<{
          nodes: AXNode[];
        }>(
          input.tabId,
          "Accessibility.getFullAXTree",
          { frameId: mapping.cdpFrameId },
        );

        const actionable = result.nodes.filter((node) => {
          if (node.ignored || !node.backendDOMNodeId) return false;
          return ACTIONABLE_ROLES.has(normalizedRole(node));
        });

        return {
          ok: true as const,
          mapping,
          actionable,
        };
      } catch (error) {
        return {
          ok: false as const,
          mapping,
          warning:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "AX frame collection failed",
        };
      }
    }),
  );

  const successful = settled.filter(
    (entry): entry is Extract<(typeof settled)[number], { ok: true }> =>
      entry.ok,
  );
  const failed = settled.filter((entry) => !entry.ok);

  const allCandidates = successful.flatMap((entry) =>
    entry.actionable.map((node) =>
      toCandidate(input.tabId, entry.mapping, node),
    ),
  );
  const allFieldCount = successful.reduce(
    (sum, entry) =>
      sum +
      entry.actionable.filter((node) =>
        FIELD_ROLES.has(normalizedRole(node)),
      ).length,
    0,
  );

  const elements = allCandidates.slice(0, maxElements);
  const truncated = elements.length < allCandidates.length;
  const returnedFieldCount = elements.filter(
    (element) => element.kind === "field",
  ).length;

  const cdpFrameIdByFrame = Object.fromEntries(
    successful.map((entry) => [
      entry.mapping.webFrameId,
      entry.mapping.cdpFrameId,
    ]),
  );

  const mainCdpFrameId = cdpFrameIdByFrame["web:0"];

  return {
    source: "ax",
    cdpFrameIdByFrame,
    ...(mainCdpFrameId !== undefined ? { mainCdpFrameId } : {}),
    coverage: {
      actionable: aggregateCoverage({
        returned: elements.length,
        totalKnown: allCandidates.length,
        truncated,
        missingFrameCount: missingFrameIds.length,
        failedFrameCount: failed.length,
      }),
      forms: aggregateCoverage({
        returned: returnedFieldCount,
        totalKnown: allFieldCount,
        truncated: truncated && returnedFieldCount < allFieldCount,
        missingFrameCount: missingFrameIds.length,
        failedFrameCount: failed.length,
      }),
      text: {
        status: "unknown",
        returned: 0,
        reason: "ax-source-currently-covers-interactive-elements-only",
      },
    },
    elements,
    ...(missingFrameIds.length > 0 || failed.length > 0
      ? {
          degradedFrames: [
            ...missingFrameIds,
            ...failed.map((entry) => entry.mapping.webFrameId),
          ],
        }
      : {}),
    warnings: [
      ...missingFrameIds.map(
        (frameId) =>
          "AX exact CDP mapping 不可用: " + frameId,
      ),
      ...failed.map(
        (entry) =>
          "AX frame " +
          entry.mapping.webFrameId +
          " 采集失败: " +
          entry.warning,
      ),
    ],
  };
}

export async function collectMainAxSource(
  input: CollectMainAxSourceInput,
): Promise<CollectedAxSource> {
  const frameTree = await input.transport.send<{
    frameTree: PageFrameTree;
  }>(
    input.tabId,
    "Page.getFrameTree",
  );

  return collectMappedAxSource({
    tabId: input.tabId,
    mappings: [
      {
        webFrameId: "web:0",
        cdpFrameId: frameTree.frameTree.frame.id,
        frameEpoch: "legacy-main-frame",
        documentEpoch: input.mainDocumentEpoch,
      },
    ],
    expectedFrameIds: input.hasChildFrames === true
      ? ["web:0", "unmapped-child"]
      : ["web:0"],
    transport: input.transport,
    ...(input.maxElements !== undefined
      ? { maxElements: input.maxElements }
      : {}),
  });
}
