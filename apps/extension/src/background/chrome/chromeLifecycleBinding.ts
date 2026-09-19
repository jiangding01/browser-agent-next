import type { DomLifecycleRegistry } from "./domLifecycleRegistry.js";

export interface ChromeEvent<T extends (...args: never[]) => void> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface ChromeLifecycleApi {
  tabs: {
    onRemoved: ChromeEvent<(tabId: number) => void>;
  };
  webNavigation: {
    onCommitted: ChromeEvent<(details: {
      tabId: number;
      frameId: number;
      documentId: string;
    }) => void>;
  };
}

export function bindChromeDomLifecycle(
  api: ChromeLifecycleApi,
  lifecycle: DomLifecycleRegistry,
): () => void {
  const onRemoved = (tabId: number): void => lifecycle.tabRemoved(tabId);
  const onCommitted = (details: {
    tabId: number;
    frameId: number;
    documentId: string;
  }): void => lifecycle.committed(details);

  api.tabs.onRemoved.addListener(onRemoved);
  api.webNavigation.onCommitted.addListener(onCommitted);

  return () => {
    api.tabs.onRemoved.removeListener(onRemoved);
    api.webNavigation.onCommitted.removeListener(onCommitted);
  };
}
