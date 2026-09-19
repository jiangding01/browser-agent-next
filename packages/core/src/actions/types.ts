import type { EffectClass } from "../effects/types.js";
import type { Ref, RevisionId } from "../state/types.js";

export type BrowserActionKind =
  | "click" | "setValue" | "selectOption" | "check" | "pressKey"
  | "scroll" | "navigate" | "fillForm" | "submit" | "upload" | "invokeCapability";

export interface BrowserAction {
  actionId: string;
  kind: BrowserActionKind;
  observedRevision?: RevisionId;
  target?: { ref: Ref };
  args?: unknown;
  expectedEffect?: { oneOf: EffectClass[] };
  authorization?: { id: string };
}

export interface ActionResult {
  actionId: string;
  status: "executed" | "blocked" | "stale" | "failed";
  observedRevision?: RevisionId;
  nextRevision?: RevisionId;
  effect?: {
    classification: "navigation" | "state-change" | "dialog" | "download" | "no-visible-change" | "unknown";
    evidence?: unknown;
  };
  errorCode?: string;
  message?: string;
}
