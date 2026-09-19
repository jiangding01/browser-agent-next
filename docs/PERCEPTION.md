# Perception IR

## Status

Phase 1 is now in progress.

Implemented:

- source-neutral perception candidate contract;
- explicit expected-source contract;
- conservative source coverage aggregation;
- strong-evidence-only cross-source semantic merge;
- linked persistent identities for one canonical ref;
- canonical BrowserObservation assembler;
- tests for identical-looking but unrelated controls.

Not implemented yet:

- live DOM source;
- live AX source;
- DOM ↔ AX backend-node correspondence bridge;
- component adapter source;
- real frame degradation collection;
- live Extension integration.

## Why an assembler exists

The Browser Runtime must not expose separate "DOM snapshot" and "AX snapshot" realities to higher-level agents.

Instead:

```text
DOM Source ─┐
AX Source  ─┼─> Perception IR ─> Semantic Merge ─> BrowserObservation
Adapters   ─┘
```

A source emits facts plus its own coverage. The assembler creates the canonical observation.

## Cross-source merge rule

The most important rule is:

> **Visible semantic similarity is not identity evidence.**

Two candidates are merged only when a browser-level source emits an explicit strong correspondence key.

Allowed future examples:

- both source records resolve to the same backend node in the same document;
- the content-script stableId registration is mapped to that exact backend node.

Forbidden merge evidence:

- same role;
- same accessible name;
- same text;
- nearby coordinates;
- same index/nth position.

If strong correspondence is absent, two same-looking controls stay separate.

## Linked identities

A canonical ref may be backed by more than one strong source identity:

```text
@e_17
 ├─ DOM: frameEpoch + stableId
 └─ AX:  documentEpoch + backendNodeId
```

The ref store can link aliases only when the perception layer already proved correspondence.

If the identities were previously allocated to two distinct active refs, linking fails closed. The runtime never rewrites history by silently merging them.

## Coverage

Every expected perception source must be named.

If the observation expects:

```text
AX + DOM
```

but DOM is missing, the resulting action-space coverage is `unknown`, not `complete`.

Conservative aggregation:

```text
any truncated → truncated
else any partial → partial
else any unknown → unknown
else all complete → complete
```

This is intentionally conservative. A later source-specific policy may refine which sources are authoritative for each dimension, but the first live implementation must prefer false escalation over false completeness.

## Field priority

When strong-linked candidates are merged, field precedence is explicit:

| Field | Priority |
|---|---|
| role/name/description | AX → DOM → adapter |
| text | DOM → AX → adapter |
| visible/enabled/state | DOM → adapter → AX |
| value | adapter → DOM → AX |
| geometry | DOM → AX → adapter |
| component metadata | adapter → DOM → AX |
| capabilities | union |

These are normalization preferences, not trust escalation. The strict executor still re-checks the live target.

## Next implementation step

Build the live DOM source first because the existing browser-agent already has a stable-id concept that can be migrated with relatively low risk. Then add AX discovery and an explicit backend-node correspondence bridge.
