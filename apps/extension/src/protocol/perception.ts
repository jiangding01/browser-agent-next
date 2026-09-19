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
  options?: ObserveDomFrameRequest["options"] & {
    /**
     * AX 目前作为显式 opt-in source 接入 canonical pipeline。
     * 在 exact DOM↔AX correspondence 完成前，不默认开启，避免同一 live
     * control 以两个独立 ref 暴露给上层。
     */
    includeAx?: boolean;
    maxAxElements?: number;
  };
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

export function isObserveTabRequest(value: unknown): value is ObserveTabRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (
    candidate.type !== "perception.observe-tab" ||
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    !Number.isInteger(candidate.tabId) ||
    typeof candidate.tabId !== "number" ||
    candidate.tabId < 0 ||
    typeof candidate.ownedBySession !== "boolean" ||
    (candidate.sinceRevision !== undefined &&
      typeof candidate.sinceRevision !== "string")
  ) {
    return false;
  }

  if (candidate.options === undefined) return true;
  if (typeof candidate.options !== "object" || candidate.options === null) {
    return false;
  }

  const options = candidate.options as Record<string, unknown>;

  return (
    (options.includeAx === undefined || typeof options.includeAx === "boolean") &&
    (options.maxAxElements === undefined ||
      (typeof options.maxAxElements === "number" &&
        Number.isInteger(options.maxAxElements) &&
        options.maxAxElements > 0))
  );
}
