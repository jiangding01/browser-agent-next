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
- [x] real Chromium MV3 E2E gate added
- [ ] import representative sanitized fixtures from real browser flows

## Phase 1 — Perception IR

### DOM baseline — PR #1
- [x] DOM source / persistent identity / real Chrome lifecycle baseline
- [x] real Chromium MV3 E2E

### Hybrid perception — PR #2
- [x] minimal read-only Chrome Debugger transport
- [x] main-frame live AX source
- [x] AX backend-node strong identity
- [x] AX coverage / truncation
- [x] AX opt-in canonical pipeline integration
- [x] child-frame-present 时 AX coverage fail-visible
- [x] isolated-world DOM identity bridge
- [x] backendDOMNodeId → live Element → stableId exact correspondence
- [x] exact mergeKey → linked Persistent Ref pipeline
- [ ] exact correspondence real Chromium E2E
- [ ] main-frame Hybrid BrowserState 默认化
- [ ] child frame webNavigation ↔ CDP frame mapping
- [ ] component adapter source

## Phase 2 — Persistent identity
- [x] DOM stable-id contract
- [x] Chrome documentId lifecycle contract
- [x] linked identity alias contract
- [x] identity conflict fails closed
- [x] tombstone semantics and retention bound
- [x] DOM lifecycle E2E
- [x] AX main-frame backend-node identity
- [x] DOM ↔ AX exact linked identity code path
- [ ] DOM ↔ AX real-browser lifecycle E2E

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] runtime-global monotonic revision ids
- [x] normalized keyed delta
- [x] baseline-reset/full-fallback contract
- [x] live DOM observation coordinator
- [x] real-browser lifecycle validation

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
