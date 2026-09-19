import type { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import type { TabStateStore } from "@browser-agent-next/runtime";
import type { DomFrameLifecycleRecorder } from "../perception/observationCoordinator.js";

export interface ChromeNavigationCommitted {
  tabId: number;
  frameId: number;
  documentId: string;
}

export interface TabScopedAuthorizationRevoker {
  clearTab(tabId: number): void;
}

export class DomLifecycleRegistry implements DomFrameLifecycleRecorder {
  private readonly frameEpochsByTab = new Map<number, Map<string, string>>();

  constructor(
    private readonly refs: InMemoryPersistentRefStore,
    private readonly states: TabStateStore,
    private readonly authorizations?: TabScopedAuthorizationRevoker,
  ) {}

  recordObserved(
    tabId: number,
    frameEpochByFrame: Readonly<Record<string, string>>,
  ): void {
    let byFrame = this.frameEpochsByTab.get(tabId);
    if (!byFrame) {
      byFrame = new Map();
      this.frameEpochsByTab.set(tabId, byFrame);
    }

    for (const [frameId, frameEpoch] of Object.entries(frameEpochByFrame)) {
      byFrame.set(frameId, frameEpoch);
    }
  }

  committed(event: ChromeNavigationCommitted): void {
    const marker = "navigation:" + event.documentId;

    if (event.frameId === 0) {
      this.refs.invalidateTab(
        event.tabId,
        marker,
        "main-document-committed",
      );
      this.states.clearTab(event.tabId);
      this.authorizations?.clearTab(event.tabId);
      this.frameEpochsByTab.delete(event.tabId);
      return;
    }

    const canonical = "web:" + event.frameId;
    const byFrame = this.frameEpochsByTab.get(event.tabId);
    const previousEpoch = byFrame?.get(canonical);

    if (previousEpoch) {
      this.refs.invalidateFrame(
        {
          tabId: event.tabId,
          frameEpoch: previousEpoch,
        },
        marker,
        "child-document-committed",
      );
    }

    // Authorization 当前绑定整个 observedRevision。任意 frame navigation 都可能
    // 改变 action/effect 上下文，因此保守撤销该 tab 上所有未消费 grant。
    this.authorizations?.clearTab(event.tabId);
    byFrame?.delete(canonical);
  }

  tabRemoved(tabId: number): void {
    this.refs.invalidateTab(
      tabId,
      "tab-removed:" + tabId,
      "tab-removed",
    );
    this.states.clearTab(tabId);
    this.authorizations?.clearTab(tabId);
    this.frameEpochsByTab.delete(tabId);
  }
}
