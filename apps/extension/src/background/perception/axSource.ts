import type {
  CoverageState,
  ElementCapability,
  ElementState,
} from "@browser-agent-next/core";
import type { PerceptionSourceResult } from "@browser-agent-next/perception";
import type { ChromeDebuggerReadTransport } from "../chrome/chromeDebuggerTransport.js";

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

export interface CollectMainAxSourceInput {
  tabId: number;
  mainDocumentEpoch: string;
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
    // AX full-tree membership is not a live visibility proof. Geometry /
    // hit-testing will come from DOM or strict live preflight.
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

function coverage(
  returned: number,
  totalKnown: number,
  truncated: boolean,
): CoverageState {
  return {
    status: truncated ? "truncated" : "complete",
    returned,
    totalKnown,
    ...(truncated ? { reason: "ax-output-cap" } : {}),
  };
}

export async function collectMainAxSource(
  input: CollectMainAxSourceInput,
): Promise<PerceptionSourceResult> {
  const maxElements = input.maxElements ?? 500;
  if (!Number.isInteger(maxElements) || maxElements < 1) {
    throw new Error("maxElements must be a positive integer");
  }

  const frameTree = await input.transport.send<{
    frameTree: PageFrameTree;
  }>(input.tabId, "Page.getFrameTree");

  const mainCdpFrameId = frameTree.frameTree.frame.id;

  const result = await input.transport.send<{
    nodes: AXNode[];
  }>(
    input.tabId,
    "Accessibility.getFullAXTree",
    { frameId: mainCdpFrameId },
  );

  const actionable = result.nodes.filter((node) => {
    if (node.ignored || !node.backendDOMNodeId) return false;
    return ACTIONABLE_ROLES.has(normalizedRole(node));
  });

  const limited = actionable.slice(0, maxElements);
  const truncated = limited.length < actionable.length;

  const elements = limited.map((node) => {
    const role = normalizedRole(node);
    const name = axString(node.name).replace(/\s+/g, " ").trim();
    const capabilities = capabilitiesFor(role);
    const value = valueFor(node);

    return {
      source: "ax" as const,
      identity: {
        source: "ax" as const,
        tabId: input.tabId,
        cdpFrameId: mainCdpFrameId,
        documentEpoch: input.mainDocumentEpoch,
        backendNodeId: node.backendDOMNodeId!,
      },
      kind: FIELD_ROLES.has(role) ? "field" as const : "element" as const,
      semantic: {
        role,
        ...(name ? { name } : {}),
      },
      state: stateFor(node),
      ...(value !== undefined ? { value } : {}),
      frameId: "web:0",
      capabilities,
    };
  });

  const fieldCount = elements.filter((element) => element.kind === "field").length;
  const totalFieldCount = actionable.filter((node) =>
    FIELD_ROLES.has(normalizedRole(node)),
  ).length;

  return {
    source: "ax",
    coverage: {
      actionable: coverage(
        elements.length,
        actionable.length,
        truncated,
      ),
      forms: coverage(
        fieldCount,
        totalFieldCount,
        truncated && fieldCount < totalFieldCount,
      ),
      text: {
        status: "unknown",
        returned: 0,
        reason: "ax-source-currently-covers-interactive-main-frame-only",
      },
    },
    elements,
    warnings: [
      "AX source 当前仅覆盖 main frame；child frame AX 将在 CDP frame mapping 完成后接入",
    ],
  };
}
