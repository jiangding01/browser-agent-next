# Extension

MV3 browser-kernel work starts here.

## Implemented

- frame-local DOM perception source;
- per-content-instance stable DOM element ids;
- open-shadow-root traversal;
- conservative actionable/form truncation reporting;
- background adapter that attaches tab/frame identity;
- value capture is opt-in and password values are never emitted.

## Important boundary

The content script does **not** know the Chrome tab id.

It emits:

```text
frameEpoch + local stableId
```

and background turns that into:

```text
tabId + frameEpoch + stableId
```

for the canonical DOM strong identity.

The DOM source is not yet wired to Native Messaging or a manifest content script. This stage establishes the live-browser-capable perception implementation before transport and orchestration are added.

## Next

- content/background message contract;
- real frame epoch lifecycle;
- canonical observation assembly in background;
- live TabStateStore integration;
- AX source and DOM↔AX strong correspondence.
