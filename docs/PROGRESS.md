# Implementation progress

Last updated: 2026-09-19

## Current branch

```text
feat/bootstrap-runtime-foundation
```

PR #1 remains Draft.

## Current phase

```text
Phase 0 Foundation        substantially complete
Phase 1 Perception IR     active
```

## Newly completed

The DOM perception path is now connected end-to-end **without committing to a Chrome transport yet**:

```text
content scan
→ typed response
→ multi-frame collector
→ canonical assembler
→ persistent refs
→ revision
→ TabStateStore
→ optional delta
```

Specific additions:

- typed content/background request/response contract;
- bounded content-side error response;
- multi-frame collector with explicit degraded-frame coverage;
- `TabRevisionRegistry` with tab-scoped opaque revision ids;
- `DomObservationCoordinator`;
- retained baseline lookup and keyed delta emission;
- synthetic transport tests proving persistent refs survive repeated observations.

## Safety properties retained

- content script does not know tab id;
- missing/inaccessible frames make coverage partial;
- unavailable delta baseline never fabricates a delta;
- delta is not treated as action freshness;
- there is still no real browser actuation.

## Next

1. Implement Chrome-specific frame messaging transport.
2. Implement browser-driven frame/document epochs and invalidation.
3. Add a real MV3 manifest/build entry and browser fixture.
4. Add lifecycle E2E:
   - same node → same ref;
   - replacement node with same name → new ref;
   - reload → new document epoch;
   - inaccessible child frame → partial coverage.
5. Add AX perception only after the DOM lifecycle is proven.

## Merge status

Do not merge PR #1 yet.

The first merge request will come after the initial real-Chrome lifecycle E2E is green and the foundation/perception invariants receive one more adversarial review.
