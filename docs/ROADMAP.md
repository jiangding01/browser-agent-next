# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR
- [x] DOM baseline — PR #1
- [x] Main-frame Hybrid — PR #2
- [x] Child-frame Hybrid — PR #3
- [ ] OOPIF/session exact mapping

## Phase 2 — Persistent identity
- [x] DOM lifecycle identity
- [x] main/child DOM ↔ AX exact linked identity

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] runtime-global revision ids
- [x] keyed delta
- [x] lifecycle invalidation

## Phase 4 — Strict executor
- [x] main-frame Strict Click closed loop
- [x] child-frame target fail closed
- [ ] child-frame coordinate projection / actuation

## Phase 5 — Effects and authorization
- [x] control-plane authorization baseline
- [x] Authorization Assurance type/ranking
- [x] minimum assurance by Effect Class
- [x] trusted-host cannot self-upgrade assurance
- [ ] operator-approved issuance ingress
- [ ] enterprise-policy issuance ingress

## Phase 6 — High-level API
- [x] browser.observe
- [x] browser.verify
- [x] browser.wait bounded polling baseline
- [x] browser.act → Strict Click
- [ ] event-driven wait
- [ ] browser.extract
- [ ] Tab Ownership Registry

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
