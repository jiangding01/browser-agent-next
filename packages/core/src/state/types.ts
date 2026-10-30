import type { EffectClass } from "../effects/types.js";

export type Ref = string;
export type RevisionId = string;

export interface StateRevision {
  id: RevisionId;
  stateEpoch: string;
  documentEpoch: string;
  sequence: number;
}

export type CoverageStatus = "complete" | "truncated" | "partial" | "unknown";

export interface CoverageState {
  status: CoverageStatus;
  returned: number;
  totalKnown?: number;
  reason?: string;
}

export interface ObservationCoverage {
  actionable: CoverageState;
  forms: CoverageState;
  text: CoverageState;
  frames: { discovered: number; accessible: number; degraded: string[] };
  shadowDom: { openRootsCovered: boolean; closedRootsUnknown: boolean };
  canvas: { present: boolean; semanticallyCovered: boolean };
}

export interface Rect { x: number; y: number; width: number; height: number; }

export interface ViewportState {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
}

export interface FrameState {
  frameId: string;
  parentFrameId?: string;
  url?: string;
  documentEpoch: string;
  accessible: boolean;
  degradedReason?: string;
}

export interface ElementCapability {
  kind: "click" | "setValue" | "selectOption" | "check" | "scrollIntoView" | "submit" | "upload" | "focus";
  valueType?: string;
  optionsKnown?: boolean;
  multiple?: boolean;
}

export interface ElementState {
  ref: Ref;
  kind: "element" | "field" | "content" | "region";
  semantic: { role: string; name?: string; description?: string; text?: string };
  state: {
    visible: boolean;
    enabled: boolean;
    focused: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
    expanded?: boolean;
    pressed?: boolean;
    required?: boolean;
    readonly?: boolean;
    /**
     * DOM 源对凭据 / 支付字段（type=password、凭据或支付类 autocomplete）的标记。
     * 只是布尔标记，不含值；写入类动作在签发前据此拒绝（不变量 141）。
     */
    sensitive?: true;
  };
  value?: { kind: "text" | "number" | "selection" | "boolean" | "date" | "unknown"; display?: unknown };
  geometry?: { rect: Rect; inViewport: boolean; hitTestable?: boolean };
  component?: { library?: string; kind?: string; searchable?: boolean };
  frameId: string;
  capabilities: ElementCapability[];
  provenance: { ax?: boolean; dom?: boolean; adapter?: string };
}

export interface FormState { ref: Ref; title?: string; fieldRefs: Ref[]; actionRefs: Ref[]; }

export interface PageCapability {
  id: string;
  origin: string;
  frameId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  effectHint?: EffectClass;
  trust: "page-declared";
}

export interface OverlayState { ref?: Ref; kind: string; blocking: boolean; }
export interface DialogState { ref?: Ref; title?: string; modal: boolean; }

export type BrowserStateChange =
  | { type: "add"; node: ElementState }
  | { type: "remove"; ref: Ref; reason?: string }
  | { type: "update"; ref: Ref; patch: Partial<ElementState> };

export interface BrowserStateDelta {
  baseRevision: RevisionId;
  revision: RevisionId;
  changes: BrowserStateChange[];
  fallbackToFull?: boolean;
}

export interface BrowserObservation {
  schemaVersion: 1;
  tab: { tabId: number; title: string; url: string; origin: string; ownedBySession: boolean };
  revision: StateRevision;
  scope: { kind: "page" | "region" | "ref"; ref?: Ref; description?: string };
  coverage: ObservationCoverage;
  viewport: ViewportState;
  frames: FrameState[];
  elements: ElementState[];
  forms?: FormState[];
  capabilities?: PageCapability[];
  overlays?: OverlayState[];
  dialogs?: DialogState[];
  delta?: BrowserStateDelta;
  warnings?: string[];
}
