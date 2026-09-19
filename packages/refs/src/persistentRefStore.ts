export type StrongIdentity =
  | { source: "dom"; tabId: number; frameEpoch: string; stableId: string }
  | { source: "ax"; tabId: number; cdpFrameId: string; documentEpoch: string; backendNodeId: number };

export type RefKind = "element" | "field" | "content";

export interface RefRecord {
  ref: string;
  identity: StrongIdentity;
  kind: RefKind;
  createdAtRevision: string;
  lastSeenRevision: string;
  tombstonedAtRevision?: string;
  tombstoneReason?: string;
}

export function identityKey(identity: StrongIdentity): string {
  if (identity.source === "dom") {
    return ["dom", identity.tabId, identity.frameEpoch, identity.stableId].join(":");
  }
  return ["ax", identity.tabId, identity.cdpFrameId, identity.documentEpoch, identity.backendNodeId].join(":");
}

function prefix(kind: RefKind): string {
  if (kind === "element") return "e";
  if (kind === "field") return "f";
  return "r";
}

export class InMemoryPersistentRefStore {
  private readonly byIdentity = new Map<string, string>();
  private readonly records = new Map<string, RefRecord>();
  private readonly counters: Record<RefKind, number> = { element: 0, field: 0, content: 0 };

  getOrCreate(identity: StrongIdentity, kind: RefKind, revision: string): string {
    const key = identityKey(identity);
    const existingRef = this.byIdentity.get(key);
    if (existingRef) {
      const existing = this.records.get(existingRef);
      if (existing && !existing.tombstonedAtRevision) {
        existing.lastSeenRevision = revision;
        return existing.ref;
      }
      this.byIdentity.delete(key);
    }

    this.counters[kind] += 1;
    const ref = "@" + prefix(kind) + "_" + this.counters[kind].toString(36).toUpperCase();
    this.byIdentity.set(key, ref);
    this.records.set(ref, { ref, identity, kind, createdAtRevision: revision, lastSeenRevision: revision });
    return ref;
  }

  byRef(ref: string): Readonly<RefRecord> | undefined { return this.records.get(ref); }

  markSeen(ref: string, revision: string): void {
    const record = this.records.get(ref);
    if (!record || record.tombstonedAtRevision) return;
    record.lastSeenRevision = revision;
  }

  tombstone(ref: string, revision: string, reason: string): void {
    const record = this.records.get(ref);
    if (!record || record.tombstonedAtRevision) return;
    record.tombstonedAtRevision = revision;
    record.tombstoneReason = reason;
    const key = identityKey(record.identity);
    if (this.byIdentity.get(key) === ref) this.byIdentity.delete(key);
  }

  invalidateFrame(selector: { tabId: number; frameEpoch?: string; cdpFrameId?: string }, revision: string, reason = "frame-invalidated"): void {
    for (const record of this.records.values()) {
      if (record.tombstonedAtRevision || record.identity.tabId !== selector.tabId) continue;
      const matches = record.identity.source === "dom"
        ? selector.frameEpoch !== undefined && record.identity.frameEpoch === selector.frameEpoch
        : selector.cdpFrameId !== undefined && record.identity.cdpFrameId === selector.cdpFrameId;
      if (matches) this.tombstone(record.ref, revision, reason);
    }
  }

  invalidateTab(tabId: number, revision: string, reason = "tab-invalidated"): void {
    for (const record of this.records.values()) {
      if (!record.tombstonedAtRevision && record.identity.tabId === tabId) {
        this.tombstone(record.ref, revision, reason);
      }
    }
  }

  activeRecords(): ReadonlyArray<Readonly<RefRecord>> {
    return [...this.records.values()].filter((record) => !record.tombstonedAtRevision);
  }
}
