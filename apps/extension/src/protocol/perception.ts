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

const MAX_REQUEST_ID_LENGTH = 256;
const MAX_REVISION_ID_LENGTH = 256;
const MAX_OBSERVE_ELEMENTS = 500;

function boundedNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedElementCount(value: unknown): boolean {
  return value === undefined || (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_OBSERVE_ELEMENTS
  );
}

function isDomObserveOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const options = value as Record<string, unknown>;

  return (
    boundedElementCount(options.maxElements) &&
    (options.includeValues === undefined || typeof options.includeValues === "boolean") &&
    (options.includeOpenShadowRoots === undefined ||
      typeof options.includeOpenShadowRoots === "boolean")
  );
}

export function isObserveDomFrameRequest(value: unknown): value is ObserveDomFrameRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "perception.observe-dom" &&
    boundedNonEmptyString(candidate.requestId, MAX_REQUEST_ID_LENGTH) &&
    isDomObserveOptions(candidate.options)
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
    !boundedNonEmptyString(candidate.requestId, MAX_REQUEST_ID_LENGTH) ||
    !Number.isInteger(candidate.tabId) ||
    typeof candidate.tabId !== "number" ||
    candidate.tabId < 0 ||
    candidate.ownedBySession !== undefined ||
    (candidate.sinceRevision !== undefined &&
      !boundedNonEmptyString(candidate.sinceRevision, MAX_REVISION_ID_LENGTH))
  ) {
    return false;
  }

  if (!isDomObserveOptions(candidate.options)) return false;
  if (candidate.options === undefined) return true;
  const options = candidate.options as Record<string, unknown>;

  return (
    (options.includeAx === undefined || typeof options.includeAx === "boolean") &&
    boundedElementCount(options.maxAxElements)
  );
}
