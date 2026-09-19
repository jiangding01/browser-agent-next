import type { BrowserObservation, ElementState } from "@browser-agent-next/core";

export interface StoredObservation {
  observation: BrowserObservation;
  byRef: ReadonlyMap<string, ElementState>;
  createdAt: number;
}

export interface TabStateStoreOptions {
  maxRevisionsPerTab?: number;
  now?: () => number;
}

/**
 * Bounded in-memory observation store.
 *
 * It intentionally stores normalized state only. DOM nodes, screenshots,
 * network bodies and secrets do not belong in this store.
 */
export class TabStateStore {
  private readonly maxRevisionsPerTab: number;
  private readonly now: () => number;
  private readonly byTab = new Map<number, Map<string, StoredObservation>>();

  constructor(options: TabStateStoreOptions = {}) {
    const max = options.maxRevisionsPerTab ?? 8;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("maxRevisionsPerTab must be a positive integer");
    }
    this.maxRevisionsPerTab = max;
    this.now = options.now ?? Date.now;
  }

  put(observation: BrowserObservation): StoredObservation {
    const tabId = observation.tab.tabId;
    let revisions = this.byTab.get(tabId);
    if (!revisions) {
      revisions = new Map();
      this.byTab.set(tabId, revisions);
    }

    const stored: StoredObservation = {
      observation,
      byRef: new Map(observation.elements.map((element) => [element.ref, element])),
      createdAt: this.now(),
    };

    // Re-inserting a revision refreshes it to newest insertion order.
    revisions.delete(observation.revision.id);
    revisions.set(observation.revision.id, stored);

    while (revisions.size > this.maxRevisionsPerTab) {
      const oldest = revisions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      revisions.delete(oldest);
    }

    return stored;
  }

  get(tabId: number, revisionId: string): StoredObservation | undefined {
    return this.byTab.get(tabId)?.get(revisionId);
  }

  latest(tabId: number): StoredObservation | undefined {
    const revisions = this.byTab.get(tabId);
    if (!revisions?.size) return undefined;
    const newest = [...revisions.values()].at(-1);
    return newest;
  }

  clearTab(tabId: number): void {
    this.byTab.delete(tabId);
  }

  clearAll(): void {
    this.byTab.clear();
  }

  revisionCount(tabId: number): number {
    return this.byTab.get(tabId)?.size ?? 0;
  }
}
