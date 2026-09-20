import type {
  InMemoryAuthorizationStore,
} from "@browser-agent-next/policy";

export interface AuthorizationLifecycleApi {
  tabs: {
    onRemoved: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
  };
  webNavigation: {
    onCommitted: {
      addListener(listener: (details: {
        tabId: number;
        frameId: number;
      }) => void): void;
      removeListener(listener: (details: {
        tabId: number;
        frameId: number;
      }) => void): void;
    };
  };
}

/**
 * 任意 committed navigation 都撤销该 tab 的短期授权。
 *
 * 即使只是 child frame 导航也 fail closed，避免 grant 在页面结构变化后继续存活。
 */
export interface TabScopedPendingAuthorizationStore {
  clearTab(tabId: number): void;
}

export function bindAuthorizationLifecycle(
  api: AuthorizationLifecycleApi,
  authorizations: InMemoryAuthorizationStore,
  pendingApprovals?: TabScopedPendingAuthorizationStore,
): () => void {
  const onRemoved = (tabId: number): void => {
    authorizations.clearTab(tabId);
    pendingApprovals?.clearTab(tabId);
  };

  const onCommitted = (details: {
    tabId: number;
    frameId: number;
  }): void => {
    authorizations.clearTab(details.tabId);
    pendingApprovals?.clearTab(details.tabId);
  };

  api.tabs.onRemoved.addListener(onRemoved);
  api.webNavigation.onCommitted.addListener(onCommitted);

  return () => {
    api.tabs.onRemoved.removeListener(onRemoved);
    api.webNavigation.onCommitted.removeListener(onCommitted);
  };
}
