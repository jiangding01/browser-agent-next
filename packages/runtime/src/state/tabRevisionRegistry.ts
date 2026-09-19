import type { StateRevision } from "@browser-agent-next/core";

/**
 * Runtime-lifetime monotonic revision allocator.
 *
 * The id includes the tab for diagnostics but uses one global sequence so
 * removing/reusing a Chrome tab id can never make an old opaque revision id
 * alias a new observation within the same runtime state epoch.
 */
export class TabRevisionRegistry {
  private sequence = 0;

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

    this.sequence += 1;

    return {
      id: this.stateEpoch + ":g" + this.sequence + ":t" + tabId,
      stateEpoch: this.stateEpoch,
      documentEpoch,
      sequence: this.sequence,
    };
  }
}
