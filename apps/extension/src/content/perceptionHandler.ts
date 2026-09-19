import type {
  PerceptionContentRequest,
  PerceptionContentResponse,
} from "../protocol/perception.js";
import type { DomFramePerceptionSource } from "./domFrameSource.js";

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "DOM perception failed";
}

export function handlePerceptionRequest(
  source: DomFramePerceptionSource,
  document: Document,
  win: Window,
  request: PerceptionContentRequest,
): PerceptionContentResponse {
  try {
    return {
      type: "perception.observe-dom.result",
      requestId: request.requestId,
      ok: true,
      snapshot: source.scan(document, win, request.options),
    };
  } catch (error) {
    return {
      type: "perception.observe-dom.result",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "DOM_PERCEPTION_FAILED",
        message: safeErrorMessage(error),
      },
    };
  }
}
