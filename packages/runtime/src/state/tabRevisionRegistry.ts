import type { StateRevision } from "@browser-agent-next/core";

export class TabRevisionRegistry {
  private readonly sequenceByTab = new Map<number, number>();

  constructor(readonly stateEpoch: string) {
    if (!stateEpoch.trim()) {
      throw new Error("stateEpoch must be non-empty");
    }
  }

  next(tabId: number, documentEpoch: string): StateRevision {
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error("tabId must be a non-negative integer");
    }
    if (!documentEpoch.trim()) {
      throw new Error("documentEpoch must be non-empty");
    }

    const sequence = (this.sequenceByTab.get(tabId) ?? 0) + 1;
    this.sequenceByTab.set(tabId, sequence);

    return {
      id: this.stateEpoch + ":t" + tabId + ":" + sequence,
      stateEpoch: this.stateEpoch,
      documentEpoch,
      sequence,
    };
  }

  resetTab(tabId: number): void {
    this.sequenceByTab.delete(tabId);
  }
}
