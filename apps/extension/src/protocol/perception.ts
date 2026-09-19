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

export type PerceptionContentRequest = ObserveDomFrameRequest;
export type PerceptionContentResponse = ObserveDomFrameResponse;
