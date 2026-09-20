# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR

### DOM baseline — PR #1
- [x] DOM source / persistent identity / lifecycle baseline
- [x] real Chromium MV3 E2E

### Main-frame Hybrid perception — PR #2
- [x] main-frame live AX source
- [x] DOM ↔ AX exact linked identity
- [x] Strict Click execution baseline

### Child-frame Hybrid perception — PR #3
- [x] frameEpoch-based webNavigation ↔ CDP exact mapping primitive
- [x] multi-frame AX collector
- [x] multi-frame DOM ↔ AX exact linker
- [ ] Chrome observation service integration
- [ ] real Chromium child Hybrid E2E
- [ ] child reload linked-identity lifecycle E2E
- [ ] coverage / invariants final review

## Phase 2 — Persistent identity
- [x] DOM lifecycle identity
- [x] AX main-frame backend-node identity
- [x] main-frame DOM ↔ AX exact linked identity
- [ ] child-frame DOM ↔ AX live linked identity

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] runtime-global revision ids
- [x] keyed delta
- [x] lifecycle invalidation

## Phase 4 — Strict executor
- [x] main-frame Strict Click closed loop
- [ ] child-frame viewport coordinate projection
- [ ] child-frame strict hit-test / dispatch
- [ ] child-frame adversarial execution E2E

## Phase 5 — Effects and authorization
- [x] control-plane authorization baseline
- [ ] Authorization Assurance levels

## Phase 6 — High-level API
- [ ] browser.observe
- [ ] browser.act
- [ ] browser.extract
- [ ] browser.verify
- [ ] event-driven wait

## Phase 7 — Intelligence
- [ ] deterministic router
- [ ] Jev CandidateBuilder
- [ ] offline replay
- [ ] shadow mode
- [ ] fast_step
- [ ] bounded fast_run

## Phase 8 — Semantic capabilities
- [ ] WebMCP discovery
- [ ] capability normalization
- [ ] policy-controlled invocation
