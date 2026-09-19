import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  StoredObservationStrictCoordinator,
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  type BackgroundRuntimeApi,
  registerObserveTabBackgroundListener,
} from "./perception/backgroundListener.js";
import {
  registerStrictExecutionBackgroundListener,
} from "./execution/backgroundListener.js";
import {
  ChromeStrictExecutionService,
} from "./execution/chromeStrictExecutionService.js";
import {
  ChromeStrictMainFrameClickResolver,
} from "./execution/chromeStrictClickResolver.js";
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
import {
  IsolatedWorldDomIdentityResolver,
} from "./perception/domAxCorrespondence.js";
import {
  IsolatedWorldDomStableIdInspector,
} from "./perception/domStableIdInspector.js";
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

const debuggerTransport =
  new ChromeDebuggerReadTransport(chrome.debugger);

const identityResolver =
  new IsolatedWorldDomIdentityResolver(debuggerTransport);

const domInspector =
  new IsolatedWorldDomStableIdInspector(debuggerTransport);

const perceptionService = new ChromeDomObservationService(
  chrome.tabs,
  chrome.webNavigation,
  coordinator,
  debuggerTransport,
);

const strictResolver =
  new ChromeStrictMainFrameClickResolver(
    refs,
    chrome.webNavigation,
    debuggerTransport,
    identityResolver,
    domInspector,
  );

const strictCoordinator =
  new StoredObservationStrictCoordinator(
    states,
    strictResolver,
  );

const strictService =
  new ChromeStrictExecutionService(strictCoordinator);

bindChromeDomLifecycle(chrome, lifecycle);
registerObserveTabBackgroundListener(
  chrome.runtime,
  perceptionService,
);
registerStrictExecutionBackgroundListener(
  chrome.runtime,
  strictService,
);
