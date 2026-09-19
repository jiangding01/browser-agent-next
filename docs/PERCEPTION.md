# Perception IR

## Status

Phase 1 is in progress.

Implemented:

- source-neutral perception candidate contract;
- explicit expected-source contract;
- conservative source coverage aggregation;
- strong-evidence-only cross-source semantic merge;
- linked persistent identities;
- canonical BrowserObservation assembler;
- frame-local DOM source;
- typed content/background DOM observation protocol;
- multi-frame DOM collector;
- background canonical observation coordinator;
- live-state-compatible revision and delta pipeline.

Not implemented yet:

- actual `chrome.runtime` / frame messaging registration;
- Chrome-driven frame lifecycle and document epochs;
- live AX source;
- DOM ↔ AX backend-node correspondence;
- component adapters;
- real-browser E2E.

## End-to-end DOM observation path

The current code now has a complete transport-neutral path:

```text
Document
  ↓
DomFramePerceptionSource
  ↓
ObserveDomFrameResponse
  ↓
DomFrameTransport
  ↓
collectDomSource
  ↓
PerceptionSourceResult
  ↓
ObservationAssembler
  ↓
BrowserObservation
  ↓
TabStateStore
  ↓
optional keyed Delta
```

Only the Chrome-specific transport binding is still missing.

## Process boundary

The content script never receives a tab id.

It returns:

```text
frameEpoch + stableId
```

Background adds:

```text
tabId + frameId
```

before creating a canonical strong DOM identity.

## Frame degradation

Multi-frame collection is fail-visible.

If a frame is inaccessible or its content observation fails:

```text
coverage → partial
degradedFrames → includes frame
warning → recorded
```

The collector never drops a failed child frame and then reports a complete action space.

## Delta

The coordinator accepts `sinceRevision`.

If the baseline is retained and document/state identity is compatible, the result may carry a keyed delta.

If the baseline is missing or incompatible, the result remains a full observation with an explicit warning.

A delta remains an optimization only. It is not a freshness proof for actions.

## Next

1. Bind `DomFrameTransport` to real Chrome frame messaging.
2. Drive frame/document epochs from Chrome lifecycle events.
3. Add browser-level tests for same-node survival and replacement-node invalidation.
4. Add AX source and exact DOM↔AX correspondence.
