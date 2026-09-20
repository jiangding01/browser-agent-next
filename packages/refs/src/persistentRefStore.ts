export type StrongIdentity =
  | { source: "dom"; tabId: number; frameEpoch: string; stableId: string }
  | { source: "ax"; tabId: number; cdpFrameId: string; documentEpoch: string; backendNodeId: number };

export type RefKind = "element" | "field" | "content";

export interface RefRecord {
  ref: string;
  identity: StrongIdentity;
  aliases: StrongIdentity[];
  kind: RefKind;
  createdAtRevision: string;
  lastSeenRevision: string;
  tombstonedAtRevision?: string;
  tombstoneReason?: string;
}

export interface PersistentRefStoreOptions {
  maxTombstones?: number;
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

function dedupeIdentities(identities: readonly StrongIdentity[]): StrongIdentity[] {
  const seen = new Set<string>();
  const result: StrongIdentity[] = [];

  for (const identity of identities) {
    const key = identityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identity);
  }

  return result;
}

export class InMemoryPersistentRefStore {
  private readonly byIdentity = new Map<string, string>();
  private readonly records = new Map<string, RefRecord>();
  private readonly counters: Record<RefKind, number> = { element: 0, field: 0, content: 0 };
  private readonly tombstoneOrder: string[] = [];
  private readonly maxTombstones: number;

  constructor(options: PersistentRefStoreOptions = {}) {
    const max = options.maxTombstones ?? 4096;
    if (!Number.isInteger(max) || max < 0) {
      throw new Error("maxTombstones must be a non-negative integer");
    }
    this.maxTombstones = max;
  }

  getOrCreate(identity: StrongIdentity, kind: RefKind, revision: string): string {
    return this.getOrCreateLinked([identity], kind, revision);
  }

  /**
   * Bind multiple strong identities that the perception layer has already
   * proven refer to the same live object.
   *
   * This method never merges two independently allocated active refs. Such a
   * conflict means the upstream cross-source correspondence is inconsistent
   * with prior observations and must fail closed instead of silently
   * rewriting identity history.
   */
  getOrCreateLinked(
    identities: readonly StrongIdentity[],
    kind: RefKind,
    revision: string,
  ): string {
    const unique = dedupeIdentities(identities);
    if (unique.length === 0) {
      throw new Error("at least one strong identity is required");
    }

    const activeRefs = new Set<string>();

    for (const identity of unique) {
      const mappedRef = this.byIdentity.get(identityKey(identity));
      if (!mappedRef) continue;
      const record = this.records.get(mappedRef);
      if (record && !record.tombstonedAtRevision) {
        activeRefs.add(mappedRef);
      }
    }

    if (activeRefs.size > 1) {
      throw new Error(
        "strong identity conflict: linked identities already belong to different active refs",
      );
    }

    const existingRef = [...activeRefs][0];

    if (existingRef) {
      const record = this.records.get(existingRef);
      if (!record) {
        throw new Error("persistent ref store is internally inconsistent");
      }
      if (record.kind !== kind) {
        throw new Error(
          `ref kind conflict: existing=${record.kind}, requested=${kind}`,
        );
      }

      const aliasesByKey = new Map(
        [record.identity, ...record.aliases].map((identity) => [
          identityKey(identity),
          identity,
        ]),
      );

      for (const identity of unique) {
        const key = identityKey(identity);
        const mappedRef = this.byIdentity.get(key);
        if (mappedRef && mappedRef !== existingRef) {
          throw new Error(
            "strong identity conflict: alias maps to a different active ref",
          );
        }
        this.byIdentity.set(key, existingRef);
        aliasesByKey.set(key, identity);
      }

      const primaryKey = identityKey(record.identity);
      record.aliases = [...aliasesByKey.entries()]
        .filter(([key]) => key !== primaryKey)
        .map(([, identity]) => identity);
      record.lastSeenRevision = revision;
      return existingRef;
    }

    this.counters[kind] += 1;
    const ref = "@" + prefix(kind) + "_" + this.counters[kind].toString(36).toUpperCase();
    const [primary, ...aliases] = unique;

    if (!primary) {
      throw new Error("at least one strong identity is required");
    }

    for (const identity of unique) {
      const key = identityKey(identity);
      const mappedRef = this.byIdentity.get(key);
      if (mappedRef) {
        const mapped = this.records.get(mappedRef);
        if (mapped && !mapped.tombstonedAtRevision) {
          throw new Error("strong identity unexpectedly became active during allocation");
        }
        this.byIdentity.delete(key);
      }
    }

    const record: RefRecord = {
      ref,
      identity: primary,
      aliases,
      kind,
      createdAtRevision: revision,
      lastSeenRevision: revision,
    };

    for (const identity of unique) {
      this.byIdentity.set(identityKey(identity), ref);
    }
    this.records.set(ref, record);

    return ref;
  }

  byRef(ref: string): Readonly<RefRecord> | undefined {
    return this.records.get(ref);
  }

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

    for (const identity of [record.identity, ...record.aliases]) {
      const key = identityKey(identity);
      if (this.byIdentity.get(key) === ref) {
        this.byIdentity.delete(key);
      }
    }

    this.tombstoneOrder.push(ref);
    this.trimTombstones();
  }

  invalidateFrame(
    selector: {
      tabId: number;
      frameEpoch?: string;
      cdpFrameId?: string;
      documentEpoch?: string;
    },
    revision: string,
    reason = "frame-invalidated",
  ): void {
    for (const record of [...this.records.values()]) {
      if (record.tombstonedAtRevision) continue;

      const identities = [record.identity, ...record.aliases];
      const matches = identities.some((identity) => {
        if (identity.tabId !== selector.tabId) return false;
        return identity.source === "dom"
          ? selector.frameEpoch !== undefined && identity.frameEpoch === selector.frameEpoch
          : selector.cdpFrameId !== undefined &&
            identity.cdpFrameId === selector.cdpFrameId &&
            (selector.documentEpoch === undefined ||
              identity.documentEpoch === selector.documentEpoch);
      });

      if (matches) this.tombstone(record.ref, revision, reason);
    }
  }

  invalidateTab(tabId: number, revision: string, reason = "tab-invalidated"): void {
    for (const record of [...this.records.values()]) {
      if (record.tombstonedAtRevision) continue;
      const identities = [record.identity, ...record.aliases];
      if (identities.some((identity) => identity.tabId === tabId)) {
        this.tombstone(record.ref, revision, reason);
      }
    }
  }

  activeRecords(): ReadonlyArray<Readonly<RefRecord>> {
    return [...this.records.values()].filter((record) => !record.tombstonedAtRevision);
  }

  tombstoneCount(): number {
    return this.tombstoneOrder.length;
  }

  private trimTombstones(): void {
    while (this.tombstoneOrder.length > this.maxTombstones) {
      const oldest = this.tombstoneOrder.shift();
      if (oldest !== undefined) {
        const record = this.records.get(oldest);
        if (record?.tombstonedAtRevision) {
          this.records.delete(oldest);
        }
      }
    }
  }
}
