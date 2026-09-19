# Perception IR

## Status

Phase 1 is in progress.

Implemented:

- source-neutral perception candidate contract;
- explicit expected-source contract;
- conservative source coverage aggregation;
- strong-evidence-only cross-source semantic merge;
- linked persistent identities for one canonical ref;
- canonical BrowserObservation assembler;
- frame-local DOM perception source;
- background DOM identity adapter.

Not implemented yet:

- content/background transport wiring;
- live frame lifecycle and invalidation;
- live AX source;
- DOM ↔ AX backend-node correspondence bridge;
- component adapter source;
- canonical background observation coordinator.

## DOM source

The first concrete source is deliberately split into two layers:

```text
Content Script
  document/window
      ↓
DomFramePerceptionSource
      ↓
frameEpoch + stableId + semantic facts
      ↓
Background
      ↓
adaptDomFrameSnapshot(tabId, frameId)
      ↓
PerceptionSourceResult
```

The page-side content source never invents or receives a tab id.

### Stable identity

A content-script instance owns a `WeakMap<Element, stableId>`.

The same live DOM object keeps the same id across repeated scans:

```text
Element A → s1
scan again → s1
Element B → s2
```

A future content-script reinjection creates a new `frameEpoch`; therefore reused local ids such as `s1` cannot collide with the previous document instance.

### Initial actionable surface

The generic DOM source currently recognizes conservative, explicit controls:

- native links/buttons;
- inputs/textarea/select;
- contenteditable;
- supported explicit ARIA roles.

It deliberately does not infer arbitrary clickable `div` elements from CSS classes or event listeners. Component adapters and AX will extend coverage later.

### Values

Value capture is **off by default**.

Even when explicitly enabled:

- password values are never emitted.

This is a data-minimization rule, not merely a model-redaction rule.

### Open shadow roots

The initial DOM source recursively scans open shadow roots.

Closed shadow roots remain outside DOM-source coverage and are represented separately by the higher-level observation coverage/trust model.

### Geometry

The source records bounding rect and whether the element intersects the viewport.

It does **not** treat observation-time geometry as proof that a future click is safe. Strict execution still performs a fresh hit test immediately before dispatch.

## Cross-source merge rule

Visible semantic similarity is not identity evidence.

Two candidates merge only through an explicit strong correspondence key produced from browser-level evidence.

Forbidden evidence:

- same role;
- same accessible name;
- same text;
- nearby coordinates;
- same list position.

## Coverage

Every expected source must be named. If AX+DOM are expected and one is missing, the overall observation is not complete.

## Next

1. Add content/background message contracts and a frame lifecycle.
2. Feed DOM source results through the canonical assembler.
3. Persist observations in TabStateStore.
4. Add AX discovery.
5. Add explicit DOM↔AX backend-node correspondence.
