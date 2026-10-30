import type {
  ElementCapability,
  ElementState,
  Rect,
  ViewportState,
} from "@browser-agent-next/core";
import { SENSITIVE_AUTOCOMPLETE_PATTERN } from "../protocol/sensitiveFields.js";

export interface DomFrameElement {
  stableId: string;
  kind: "element" | "field";
  semantic: ElementState["semantic"];
  state: ElementState["state"];
  value?: ElementState["value"];
  geometry?: ElementState["geometry"];
  capabilities: ElementCapability[];
}

export interface DomFrameSnapshot {
  source: "dom";
  frameEpoch: string;
  viewport: ViewportState;
  elements: DomFrameElement[];
  coverage: {
    actionable: {
      status: "complete" | "truncated";
      returned: number;
      totalKnown: number;
      reason?: string;
    };
    forms: {
      status: "complete" | "truncated";
      returned: number;
      totalKnown: number;
      reason?: string;
    };
    text: {
      status: "unknown";
      returned: 0;
      reason: string;
    };
  };
  openShadowRootCount: number;
  warnings?: string[];
}

export interface DomFrameScanOptions {
  maxElements?: number;
  includeValues?: boolean;
  includeOpenShadowRoots?: boolean;
}

const ACTIONABLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role]",
].join(",");

const ACTIONABLE_ARIA_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "slider",
  "spinbutton",
]);

function mintEpoch(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  } catch {
    return "r" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export class StableDomIdRegistry {
  private readonly ids = new WeakMap<Element, string>();
  private readonly elementsById = new Map<string, WeakRef<Element>>();
  private counter = 0;

  idFor(element: Element): string {
    const existing = this.ids.get(element);
    if (existing) return existing;

    this.counter += 1;
    const id = "s" + this.counter;
    this.ids.set(element, id);
    this.elementsById.set(id, new WeakRef(element));
    return id;
  }

  existingIdFor(element: Element): string | undefined {
    return this.ids.get(element);
  }

  resolve(stableId: string): Element | undefined {
    const element = this.elementsById.get(stableId)?.deref();

    if (!element || !element.isConnected) {
      this.elementsById.delete(stableId);
      return undefined;
    }

    return element;
  }
}

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
}

function nativeRole(element: Element): string | undefined {
  const explicit = normalizeText(element.getAttribute("role"))?.toLowerCase();
  if (explicit) {
    return ACTIONABLE_ARIA_ROLES.has(explicit) ? explicit : undefined;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";

  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }

  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = input.type.toLowerCase();

    if (type === "button" || type === "submit" || type === "reset" || type === "file") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    return "textbox";
  }

  if (element.getAttribute("contenteditable") === "true") return "textbox";
  return undefined;
}

function labelledByText(element: Element): string | undefined {
  const labelledBy = normalizeText(element.getAttribute("aria-labelledby"));
  if (!labelledBy) return undefined;

  const root = element.getRootNode();
  const parts: string[] = [];

  for (const id of labelledBy.split(/\s+/)) {
    let node: Element | null = null;

    if (root instanceof Document) node = root.getElementById(id);
    else if (root instanceof ShadowRoot) node = root.getElementById(id);

    const text = normalizeText(node?.textContent);
    if (text) parts.push(text);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function nativeLabelText(element: Element): string | undefined {
  const maybeLabelled = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const labels = "labels" in maybeLabelled ? maybeLabelled.labels : null;

  if (labels?.length) {
    const text = Array.from(labels)
      .map((label) => normalizeText(label.textContent))
      .filter((value): value is string => value !== undefined)
      .join(" ");
    if (text) return text;
  }

  return undefined;
}

function accessibleName(element: Element): string | undefined {
  const aria = normalizeText(element.getAttribute("aria-label"));
  if (aria) return aria;

  const labelled = labelledByText(element);
  if (labelled) return labelled;

  const nativeLabel = nativeLabelText(element);
  if (nativeLabel) return nativeLabel;

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      const value = normalizeText(element.value);
      if (value) return value;
    }
    const placeholder = normalizeText(element.placeholder);
    if (placeholder) return placeholder;
  }

  if (element instanceof HTMLTextAreaElement) {
    const placeholder = normalizeText(element.placeholder);
    if (placeholder) return placeholder;
  }

  const text = normalizeText(element.textContent);
  if (text) return text.slice(0, 240);

  return normalizeText(element.getAttribute("title"))?.slice(0, 240);
}

function visible(element: Element, win: Window): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden) return false;
  if (element.closest("[hidden],[inert]")) return false;

  const style = win.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function enabled(element: Element): boolean {
  if (element.getAttribute("aria-disabled") === "true") return false;
  if (element.closest("[inert]")) return false;

  if ("disabled" in element) {
    return !(element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled;
  }

  return true;
}

// 凭据与支付类 autocomplete token；写入类动作在签发前据此拒绝。
const SENSITIVE_AUTOCOMPLETE = new RegExp(SENSITIVE_AUTOCOMPLETE_PATTERN);

/**
 * 凭据 / 支付字段：只产生布尔标记，绝不读取值。
 *
 * password 类型、凭据 / 支付 autocomplete（input 与 textarea 都看），以及用
 * `-webkit-text-security` 遮盖输入的字段（“显示密码”切换或自绘密码框）。
 */
export function isSensitiveField(element: Element, win?: Window): boolean {
  const isInput = element instanceof HTMLInputElement;
  if (!isInput && !(element instanceof HTMLTextAreaElement)) return false;
  if (isInput && element.type.toLowerCase() === "password") return true;
  if (
    SENSITIVE_AUTOCOMPLETE.test(
      (element.getAttribute("autocomplete") ?? "").toLowerCase(),
    )
  ) {
    return true;
  }
  const masking = win
    ?.getComputedStyle(element)
    .getPropertyValue("-webkit-text-security")
    .trim();
  return masking !== undefined && masking !== "" && masking !== "none";
}

function stateFor(element: Element, win: Window): ElementState["state"] {
  const checked =
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
      ? element.indeterminate
        ? "mixed"
        : element.checked
      : undefined;

  const selected = element instanceof HTMLOptionElement ? element.selected : undefined;
  const expanded = element.hasAttribute("aria-expanded")
    ? element.getAttribute("aria-expanded") === "true"
    : undefined;
  const pressed = element.hasAttribute("aria-pressed")
    ? element.getAttribute("aria-pressed") === "true"
    : undefined;

  const required =
    "required" in element
      ? Boolean((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).required)
      : element.getAttribute("aria-required") === "true"
        ? true
        : undefined;

  const readonly =
    "readOnly" in element
      ? Boolean((element as HTMLInputElement | HTMLTextAreaElement).readOnly)
      : element.getAttribute("aria-readonly") === "true"
        ? true
        : undefined;

  return {
    visible: visible(element, win),
    enabled: enabled(element),
    focused: element.ownerDocument.activeElement === element,
    ...(selected !== undefined ? { selected } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
    ...(pressed !== undefined ? { pressed } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(readonly !== undefined ? { readonly } : {}),
    ...(isSensitiveField(element, win) ? { sensitive: true as const } : {}),
  };
}

function rectFor(element: Element, win: Window): ElementState["geometry"] {
  const rect = element.getBoundingClientRect();
  const normalized: Rect = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };

  const inViewport =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < win.innerHeight &&
    rect.left < win.innerWidth;

  return { rect: normalized, inViewport };
}

function capabilitiesFor(element: Element, role: string): ElementCapability[] {
  const capabilities: ElementCapability[] = [];

  if (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "menuitemcheckbox" ||
    role === "menuitemradio" ||
    role === "tab" ||
    role === "treeitem" ||
    role === "option"
  ) {
    capabilities.push({ kind: "click" });
  }

  if (role === "checkbox" || role === "radio" || role === "switch") {
    capabilities.push({ kind: "click" }, { kind: "check" });
  }

  if (role === "textbox" || role === "searchbox" || role === "spinbutton") {
    capabilities.push({ kind: "setValue", valueType: "text" }, { kind: "focus" });
  }

  if (role === "combobox" || role === "listbox") {
    capabilities.push({ kind: "selectOption" }, { kind: "focus" });
  }

  if (role === "slider") capabilities.push({ kind: "focus" });

  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "file") {
    capabilities.push({ kind: "upload", multiple: element.multiple });
  }

  return capabilities;
}

function valueFor(element: Element): ElementState["value"] | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type.toLowerCase() === "password") return undefined;
    if (element.type.toLowerCase() === "checkbox" || element.type.toLowerCase() === "radio") {
      return { kind: "boolean", display: element.checked };
    }
    return { kind: "text", display: element.value };
  }

  if (element instanceof HTMLTextAreaElement) return { kind: "text", display: element.value };

  if (element instanceof HTMLSelectElement) {
    return {
      kind: "selection",
      display: element.multiple
        ? Array.from(element.selectedOptions).map((option) => option.text)
        : element.selectedOptions[0]?.text ?? element.value,
    };
  }

  if (element.getAttribute("contenteditable") === "true") {
    return { kind: "text", display: element.textContent ?? "" };
  }

  return undefined;
}

function scanRoots(document: Document, includeOpenShadowRoots: boolean): {
  roots: Array<Document | ShadowRoot>;
  openShadowRootCount: number;
} {
  const roots: Array<Document | ShadowRoot> = [document];
  if (!includeOpenShadowRoots) return { roots, openShadowRootCount: 0 };

  let cursor = 0;
  let count = 0;

  while (cursor < roots.length) {
    const root = roots[cursor++]!;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        count += 1;
      }
    }
  }

  return { roots, openShadowRootCount: count };
}

function viewportFor(document: Document, win: Window): ViewportState {
  const root = document.scrollingElement ?? document.documentElement;
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    scrollWidth: root?.scrollWidth ?? win.innerWidth,
    scrollHeight: root?.scrollHeight ?? win.innerHeight,
  };
}

export class DomFramePerceptionSource {
  readonly frameEpoch: string;
  private readonly stableIds = new StableDomIdRegistry();

  constructor(frameEpoch = mintEpoch()) {
    this.frameEpoch = frameEpoch;
  }

  stableIdOf(element: Element): string | undefined {
    if (!element.isConnected) return undefined;
    return this.stableIds.existingIdFor(element);
  }

  resolveStableId(stableId: string): Element | undefined {
    return this.stableIds.resolve(stableId);
  }

  scan(
    document: Document,
    win: Window,
    options: DomFrameScanOptions = {},
  ): DomFrameSnapshot {
    const maxElements = options.maxElements ?? 500;
    if (!Number.isInteger(maxElements) || maxElements < 1) {
      throw new Error("maxElements must be a positive integer");
    }

    const { roots, openShadowRootCount } = scanRoots(
      document,
      options.includeOpenShadowRoots ?? true,
    );

    const seen = new Set<Element>();
    const all: DomFrameElement[] = [];

    for (const root of roots) {
      for (const element of Array.from(root.querySelectorAll(ACTIONABLE_SELECTOR))) {
        if (seen.has(element)) continue;
        seen.add(element);

        const role = nativeRole(element);
        if (!role) continue;

        const state = stateFor(element, win);
        if (!state.visible) continue;

        const capabilities = capabilitiesFor(element, role);
        if (capabilities.length === 0) continue;

        const name = accessibleName(element);
        const text = normalizeText(element.textContent)?.slice(0, 240);
        const semantic: ElementState["semantic"] = {
          role,
          ...(name !== undefined ? { name } : {}),
          ...(text !== undefined ? { text } : {}),
        };

        const isField = capabilities.some((capability) =>
          capability.kind === "setValue" ||
          capability.kind === "selectOption" ||
          capability.kind === "check" ||
          capability.kind === "upload",
        );

        const value = options.includeValues ? valueFor(element) : undefined;

        all.push({
          stableId: this.stableIds.idFor(element),
          kind: isField ? "field" : "element",
          semantic,
          state,
          ...(value !== undefined ? { value } : {}),
          geometry: rectFor(element, win),
          capabilities,
        });
      }
    }

    const elements = all.slice(0, maxElements);
    const truncated = elements.length < all.length;
    const allFields = all.filter((element) => element.kind === "field");
    const returnedFields = elements.filter((element) => element.kind === "field").length;

    return {
      source: "dom",
      frameEpoch: this.frameEpoch,
      viewport: viewportFor(document, win),
      elements,
      coverage: {
        actionable: {
          status: truncated ? "truncated" : "complete",
          returned: elements.length,
          totalKnown: all.length,
          ...(truncated ? { reason: "dom-output-cap" } : {}),
        },
        forms: {
          status: truncated && returnedFields < allFields.length ? "truncated" : "complete",
          returned: returnedFields,
          totalKnown: allFields.length,
          ...(truncated && returnedFields < allFields.length ? { reason: "dom-output-cap" } : {}),
        },
        text: {
          status: "unknown",
          returned: 0,
          reason: "dom-source-does-not-scan-general-page-text",
        },
      },
      openShadowRootCount,
      ...(truncated
        ? { warnings: [`DOM perception truncated ${all.length} actionable elements to ${maxElements}`] }
        : {}),
    };
  }
}
