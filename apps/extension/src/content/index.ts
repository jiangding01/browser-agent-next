import { DomFramePerceptionSource } from "./domFrameSource.js";
import { installDomIdentityBridge } from "./domIdentityBridge.js";
import {
  registerDomPerceptionContentListener,
  type ContentRuntimeApi,
} from "./perceptionListener.js";

declare const chrome: {
  runtime: ContentRuntimeApi;
};

const source = new DomFramePerceptionSource();

installDomIdentityBridge(globalThis, source);
registerDomPerceptionContentListener(
  chrome.runtime,
  document,
  window,
  source,
);
