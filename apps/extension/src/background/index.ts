import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  type BackgroundRuntimeApi,
  registerObserveTabBackgroundListener,
} from "./perception/backgroundListener.js";
import {
  type ChromeLifecycleApi,
  bindChromeDomLifecycle,
} from "./chrome/chromeLifecycleBinding.js";
import {
  ChromeDomObservationService,
  type ChromeTabsApi,
} from "./chrome/chromeObservationService.js";
import {
  ChromeDebuggerReadTransport,
  type ChromeDebuggerApi,
} from "./chrome/chromeDebuggerTransport.js";
import type { ChromeWebNavigationApi } from "./chrome/chromeFrameDiscovery.js";
import { DomLifecycleRegistry } from "./chrome/domLifecycleRegistry.js";
import { DomObservationCoordinator } from "./perception/observationCoordinator.js";

interface ChromeBackgroundApi extends ChromeLifecycleApi {
  runtime: BackgroundRuntimeApi;
  debugger: ChromeDebuggerApi;
  tabs: ChromeLifecycleApi["tabs"] & ChromeTabsApi;
  webNavigation: ChromeLifecycleApi["webNavigation"] & ChromeWebNavigationApi;
}

declare const chrome: ChromeBackgroundApi;

function runtimeEpoch(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  } catch {
    return "runtime-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

const refs = new InMemoryPersistentRefStore();
const states = new TabStateStore();
const revisions = new TabRevisionRegistry(runtimeEpoch());
const lifecycle = new DomLifecycleRegistry(refs, states);
const coordinator = new DomObservationCoordinator(
  refs,
  revisions,
  states,
  lifecycle,
);
const debuggerTransport = new ChromeDebuggerReadTransport(chrome.debugger);
const service = new ChromeDomObservationService(
  chrome.tabs,
  chrome.webNavigation,
  coordinator,
  debuggerTransport,
);

bindChromeDomLifecycle(chrome, lifecycle);
registerObserveTabBackgroundListener(chrome.runtime, service);
