import {
  registerDomPerceptionContentListener,
  type ContentRuntimeApi,
} from "./perceptionListener.js";

declare const chrome: {
  runtime: ContentRuntimeApi;
};

registerDomPerceptionContentListener(
  chrome.runtime,
  document,
  window,
);
