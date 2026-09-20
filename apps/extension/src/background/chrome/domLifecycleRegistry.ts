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
  private readonly frameEpochsByTab = new Map<number, Map<string, {
    frameEpoch: string;
    cdpFrameId?: string;
    documentEpoch?: string;
  }>>();

  constructor(
    private readonly refs: InMemoryPersistentRefStore,
    private readonly states: TabStateStore,
    private readonly authorizations?: TabScopedAuthorizationRevoker,
  ) {}

  recordObserved(
    tabId: number,
    frameEpochByFrame: Readonly<Record<string, string>>,
    frameBindingsByFrame?: Readonly<Record<string, {
      frameEpoch: string;
      cdpFrameId: string;
      documentEpoch: string;
    }>>,
    documentEpochByFrame?: Readonly<Record<string, string>>,
  ): void {
    let byFrame = this.frameEpochsByTab.get(tabId);
    if (!byFrame) {
      byFrame = new Map();
      this.frameEpochsByTab.set(tabId, byFrame);
    }

    for (const [frameId, frameEpoch] of Object.entries(frameEpochByFrame)) {
      const binding = frameBindingsByFrame?.[frameId];
      const previous = byFrame.get(frameId);
      const documentEpoch =
        binding?.documentEpoch ?? documentEpochByFrame?.[frameId];
      const next = {
        frameEpoch,
        ...(documentEpoch !== undefined ? { documentEpoch } : {}),
        ...(binding?.cdpFrameId !== undefined
          ? { cdpFrameId: binding.cdpFrameId }
          : {}),
      };

      if (
        previous &&
        (previous.frameEpoch !== frameEpoch ||
          (previous.documentEpoch !== undefined &&
            documentEpoch !== undefined &&
            previous.documentEpoch !== documentEpoch))
      ) {
        const invalidationMarker =
          "observation:" +
          (documentEpoch ?? "frame-" + frameEpoch.slice(0, 128));
        if (frameId === "web:0") {
          // Invalidate each previously observed frame identity explicitly so
          // this remains safe if lifecycle recording is moved after assembly.
          for (const previousFrame of byFrame.values()) {
            this.refs.invalidateFrame(
              {
                tabId,
                frameEpoch: previousFrame.frameEpoch,
                ...(previousFrame.cdpFrameId !== undefined
                  ? { cdpFrameId: previousFrame.cdpFrameId }
                  : {}),
                ...(previousFrame.documentEpoch !== undefined
                  ? { documentEpoch: previousFrame.documentEpoch }
                  : {}),
              },
              invalidationMarker,
              "main-document-observed",
            );
          }
          this.states.clearTab(tabId);
        } else {
          this.refs.invalidateFrame(
            {
              tabId,
              frameEpoch: previous.frameEpoch,
              ...(previous.cdpFrameId !== undefined
                ? { cdpFrameId: previous.cdpFrameId }
                : {}),
              ...(previous.documentEpoch !== undefined
                ? { documentEpoch: previous.documentEpoch }
                : {}),
            },
            invalidationMarker,
            "child-document-observed",
          );
        }
        this.authorizations?.clearTab(tabId);
      }

      if (
        binding === undefined &&
        previous?.frameEpoch === frameEpoch &&
        (documentEpoch === undefined ||
          previous.documentEpoch === documentEpoch)
      ) {
        // A later DOM-only/degraded observation may lack AX correspondence.
        // Preserve an exact binding only for the same known document.
        continue;
      }

      byFrame.set(frameId, next);
    }
  }

  committed(event: ChromeNavigationCommitted): void {
    const marker = "navigation:" + event.documentId;
    const committedDocumentEpoch =
      "chrome-document:" + event.documentId;

    if (event.frameId === 0) {
      const observedMain = this.frameEpochsByTab
        .get(event.tabId)
        ?.get("web:0");

      if (observedMain?.documentEpoch === committedDocumentEpoch) {
        this.authorizations?.clearTab(event.tabId);
        return;
      }

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
    const previous = byFrame?.get(canonical);

    if (previous?.documentEpoch === committedDocumentEpoch) {
      // The observation already belongs to this committed document. The
      // event may simply have been delivered after the observation request.
      this.authorizations?.clearTab(event.tabId);
      return;
    }

    if (previous) {
      this.refs.invalidateFrame(
        {
          tabId: event.tabId,
          frameEpoch: previous.frameEpoch,
          ...(previous.cdpFrameId !== undefined
            ? { cdpFrameId: previous.cdpFrameId }
            : {}),
          ...(previous.documentEpoch !== undefined
            ? { documentEpoch: previous.documentEpoch }
            : {}),
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
