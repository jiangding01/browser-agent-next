import type { BrowserObservation } from "@browser-agent-next/core";
import type { DomFrameSnapshot } from "../content/domFrameSource.js";

export interface ObserveDomFrameRequest {
  type: "perception.observe-dom";
  requestId: string;
  options?: {
    maxElements?: number;
    includeValues?: boolean;
    includeOpenShadowRoots?: boolean;
  };
}

export type ObserveDomFrameResponse =
  | {
      type: "perception.observe-dom.result";
      requestId: string;
      ok: true;
      snapshot: DomFrameSnapshot;
    }
  | {
      type: "perception.observe-dom.result";
      requestId: string;
      ok: false;
      error: {
        code: "DOM_PERCEPTION_FAILED";
        message: string;
      };
    };

export interface ObserveTabRequest {
  type: "perception.observe-tab";
  requestId: string;
  tabId: number;
  ownedBySession: boolean;
  sinceRevision?: string;
  options?: ObserveDomFrameRequest["options"];
}

export type ObserveTabResponse =
  | {
      type: "perception.observe-tab.result";
      requestId: string;
      ok: true;
      observation: BrowserObservation;
    }
  | {
      type: "perception.observe-tab.result";
      requestId: string;
      ok: false;
      error: {
        code: "TAB_PERCEPTION_FAILED";
        message: string;
      };
    };

export type PerceptionContentRequest = ObserveDomFrameRequest;
export type PerceptionContentResponse = ObserveDomFrameResponse;

export function isObserveDomFrameRequest(value: unknown): value is ObserveDomFrameRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "perception.observe-dom" &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0
  );
}

export function isObserveDomFrameResponse(value: unknown): value is ObserveDomFrameResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "perception.observe-dom.result" ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.ok !== "boolean"
  ) {
    return false;
  }
  return candidate.ok
    ? typeof candidate.snapshot === "object" && candidate.snapshot !== null
    : typeof candidate.error === "object" && candidate.error !== null;
}
