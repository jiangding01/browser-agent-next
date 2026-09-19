# Roadmap

## Phase 0 — Foundation and evaluation
- [x] monorepo scaffold
- [x] BrowserState protocol types
- [x] coverage contract + helpers
- [x] action/effect/verification contracts
- [x] PersistentRefStore foundation
- [x] conservative effect policy
- [x] bounded TabStateStore
- [x] conservative BrowserState delta builder
- [x] browser-independent strict preflight contract
- [x] baseline trace/metrics schema
- [x] evaluation methodology
- [ ] real-world fixture corpus

## Phase 1 — Perception IR
- [ ] canonical BrowserObservation assembler
- [ ] AX source
- [ ] DOM source
- [ ] semantic merge
- [ ] explicit frame degradation/coverage

## Phase 2 — Persistent identity
- [ ] DOM stable-id integration
- [ ] AX backend-node integration
- [ ] frame/document epochs
- [x] tombstone semantics and retention bound
- [ ] lifecycle E2E

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] normalized keyed delta
- [x] unchanged response
- [x] baseline-reset/full-fallback contract
- [ ] live observation integration

## Phase 4 — Strict executor
- [x] pure strict preflight contract
- [ ] stored-observation coordinator
- [ ] strong live identity resolution
- [ ] semantic compatibility integration
- [ ] viewport + hit test integration
- [ ] no semantic stale fallback
- [ ] replacement-node adversarial E2E

## Phase 5 — Effects and authorization
- [ ] effect classifier
- [ ] origin policy
- [ ] owned-tab policy
- [ ] authorization token contract

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

## Phase 9 — Learning workflows
- [ ] unified trajectory
- [ ] recipe draft compiler
- [ ] replay verification
- [ ] human promotion gate

## Phase 10 — Visual fallback
- [ ] conditional screenshots
- [ ] coordinate safeguards
- [ ] vision/CUA provider
