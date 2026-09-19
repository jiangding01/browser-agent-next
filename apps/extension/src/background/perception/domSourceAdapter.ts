import type { PerceptionSourceResult } from "@browser-agent-next/perception";
import type { DomFrameSnapshot } from "../../content/domFrameSource.js";

export interface DomSourceAdapterInput {
  tabId: number;
  frameId: string;
  snapshot: DomFrameSnapshot;
}

/**
 * Convert a frame-local content-script snapshot into the canonical perception
 * source contract. The content script deliberately does not know Chrome's
 * tabId; background attaches that process-level identity here.
 */
export function adaptDomFrameSnapshot(
  input: DomSourceAdapterInput,
): PerceptionSourceResult {
  const { tabId, frameId, snapshot } = input;

  return {
    source: "dom",
    coverage: snapshot.coverage,
    elements: snapshot.elements.map((element) => ({
      source: "dom",
      identity: {
        source: "dom",
        tabId,
        frameEpoch: snapshot.frameEpoch,
        stableId: element.stableId,
      },
      kind: element.kind,
      semantic: element.semantic,
      state: element.state,
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.geometry !== undefined ? { geometry: element.geometry } : {}),
      frameId,
      capabilities: element.capabilities,
    })),
    ...(snapshot.warnings !== undefined ? { warnings: snapshot.warnings } : {}),
  };
}
