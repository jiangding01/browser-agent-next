# Implementation progress

Last updated: 2026-09-19

## Current branch

```text
feat/bootstrap-runtime-foundation
```

PR: #1 — still Draft.

## Current phase

```text
Phase 0 Foundation        substantially complete
Phase 1 Perception IR     in progress
```

## Completed foundation

- monorepo + CI;
- BrowserObservation / StateRevision;
- explicit observation coverage;
- typed action / effect / verification contracts;
- PersistentRefStore and tombstones;
- bounded TabStateStore;
- keyed observation delta;
- strict target preflight;
- conservative effect policy;
- evaluation fixtures and trace schema.

## Phase 1 completed in this iteration

- introduced `@browser-agent-next/perception`;
- defined DOM / AX / adapter source-neutral candidate contracts;
- added explicit `expectedSources` so an omitted source cannot silently produce a "complete" observation;
- added conservative source-coverage aggregation;
- added strong-evidence-only semantic merge;
- extended PersistentRefStore to link multiple proven strong identities to one ref;
- added fail-closed identity-conflict handling;
- added canonical BrowserObservation assembler;
- added tests proving same-looking controls do not merge without a strong cross-source correspondence key.

## Next

1. Implement the live DOM perception source in the MV3 extension.
2. Reuse the stable-id concept proven in the original browser-agent.
3. Introduce real frame epochs.
4. Feed the DOM source into the canonical assembler and TabStateStore.
5. Add AX discovery and explicit DOM↔AX backend-node correspondence.
6. Only after live identity works, connect the strict executor coordinator.

## Merge status

Do **not** merge PR #1 yet.

Before asking for merge:

- Phase 1 contracts must be green in CI;
- live DOM integration should have at least one browser-level lifecycle test;
- docs/invariants will receive another adversarial review.
