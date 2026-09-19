import {
  isObserveDomFrameRequest,
  type ObserveDomFrameResponse,
} from "../protocol/perception.js";
import { DomFramePerceptionSource } from "./domFrameSource.js";
import { handlePerceptionRequest } from "./perceptionHandler.js";

export interface RuntimeMessageEvent {
  addListener(
    listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: ObserveDomFrameResponse) => void,
    ) => boolean | void,
  ): void;
  removeListener(
    listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: ObserveDomFrameResponse) => void,
    ) => boolean | void,
  ): void;
}

export interface ContentRuntimeApi {
  onMessage: RuntimeMessageEvent;
}

export function registerDomPerceptionContentListener(
  runtime: ContentRuntimeApi,
  document: Document,
  win: Window,
  source = new DomFramePerceptionSource(),
): () => void {
  const listener = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: ObserveDomFrameResponse) => void,
  ): boolean | void => {
    if (!isObserveDomFrameRequest(message)) return;

    sendResponse(
      handlePerceptionRequest(
        source,
        document,
        win,
        message,
      ),
    );
    return false;
  };

  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}
