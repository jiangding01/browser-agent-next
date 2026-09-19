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

## Completed

### Foundation

- BrowserObservation / StateRevision;
- explicit observation coverage;
- PersistentRefStore and bounded tombstones;
- TabStateStore;
- keyed observation delta;
- strict target preflight;
- effect policy;
- eval fixtures and trace schema.

### Perception contracts

- source-neutral AX/DOM/adapter candidates;
- expected-source completeness contract;
- strong-evidence-only semantic merge;
- linked strong identities;
- canonical BrowserObservation assembler.

### DOM source

- frame-local stable DOM identity via WeakMap;
- frame epoch scoped identity;
- conservative native/ARIA actionable discovery;
- open-shadow-root traversal;
- opt-in value capture with password exclusion;
- geometry and viewport observation;
- explicit truncation coverage;
- background adapter attaches tab/frame identity.

## Current safety boundary

There is still **no real browser actuation** in the new repository.

Observation-time geometry is not used as a click safety proof. Strict live hit testing remains a Phase 4 requirement.

## Next implementation

1. Add the typed content/background perception message contract.
2. Add live frame-epoch lifecycle.
3. Assemble real DOM source results in background.
4. Store live BrowserObservations in TabStateStore.
5. Add AX source and strong DOM↔AX correspondence.
6. Then build the Extension-side strict executor coordinator.

## Merge status

Do not merge PR #1 yet.

I will request a merge only after:

- CI remains green;
- DOM source is wired through at least a synthetic/background lifecycle path;
- identity/coverage invariants receive another review;
- the first browser-level lifecycle test exists.
