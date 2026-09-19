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
- [x] initial normalized regression fixture corpus
- [ ] import representative sanitized fixtures from real browser flows

## Phase 1 — Perception IR
- [x] source-neutral perception candidate contract
- [x] canonical BrowserObservation assembler
- [x] strong-evidence-only semantic merge
- [x] conservative expected-source coverage aggregation
- [x] linked DOM/AX persistent identity contract
- [x] frame-local DOM perception source
- [x] background DOM identity adapter
- [ ] content/background message wiring
- [ ] live frame lifecycle / epoch invalidation
- [ ] live AX source
- [ ] DOM ↔ AX backend-node correspondence bridge
- [ ] component adapter source
- [ ] canonical background observation coordinator

## Phase 2 — Persistent identity
- [ ] DOM stable-id live transport integration
- [ ] AX backend-node live integration
- [ ] frame/document epochs driven by browser lifecycle
- [x] linked identity alias contract
- [x] identity conflict fails closed
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
