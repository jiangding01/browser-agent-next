import type { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import type { TabStateStore } from "@browser-agent-next/runtime";
import type { DomFrameLifecycleRecorder } from "../perception/observationCoordinator.js";

export interface ChromeNavigationCommitted {
  tabId: number;
  frameId: number;
  documentId: string;
}

export class DomLifecycleRegistry implements DomFrameLifecycleRecorder {
  private readonly frameEpochsByTab = new Map<number, Map<string, string>>();

  constructor(
    private readonly refs: InMemoryPersistentRefStore,
    private readonly states: TabStateStore,
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
      this.refs.invalidateTab(event.tabId, marker, "main-document-committed");
      this.states.clearTab(event.tabId);
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

    byFrame?.delete(canonical);
  }

  tabRemoved(tabId: number): void {
    this.refs.invalidateTab(
      tabId,
      "tab-removed:" + tabId,
      "tab-removed",
    );
    this.states.clearTab(tabId);
    this.frameEpochsByTab.delete(tabId);
  }
}
