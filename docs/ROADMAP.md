# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR

### DOM baseline — PR #1
- [x] DOM source / persistent identity / lifecycle baseline
- [x] real Chromium MV3 E2E

### Hybrid perception — PR #2
- [x] read-only Chrome Debugger transport
- [x] main-frame live AX source
- [x] AX opt-in canonical pipeline
- [x] isolated-world DOM identity bridge
- [x] backendDOMNodeId → live Element → stableId exact correspondence
- [x] exact mergeKey → linked Persistent Ref
- [x] exact correspondence real Chromium E2E
- [ ] main-frame Hybrid BrowserState 默认化
- [ ] child frame webNavigation ↔ CDP frame mapping
- [ ] component adapter source

## Phase 2 — Persistent identity
- [x] DOM lifecycle identity
- [x] AX main-frame backend-node identity
- [x] DOM ↔ AX exact linked identity
- [x] DOM ↔ AX real-browser lifecycle E2E

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] runtime-global revision ids
- [x] keyed delta
- [x] lifecycle invalidation

## Phase 4 — Strict executor
- [x] pure strict preflight
- [x] stored-observation coordinator
- [x] main-frame linked strong live identity resolution
- [x] semantic compatibility integration
- [x] viewport + isolated-world hit-test integration
- [x] no semantic stale fallback
- [x] strict prepare real Chromium E2E
- [x] generic click defaults to unknown effect
- [x] trusted authorization grant contract
- [x] exact origin allowlist
- [x] lifecycle grant revocation
- [x] commit-before-dispatch second strict prepare
- [x] CDP mouse dispatch primitive
- [x] ambiguous outcome / no-auto-retry guard
- [x] observation verification engine
- [x] trusted authorization ingress
- [x] Policy-gated execute command
- [x] execute → fresh observe → verify integration
- [x] replacement-node adversarial execution E2E

## Phase 5 — Effects and authorization
- [x] conservative generic-click effect assessment
- [x] origin policy interface
- [x] exact-origin allowlist
- [x] trusted grant exact binding / TTL / single-use
- [x] navigation/tab revocation lifecycle
- [x] trusted host ingress

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
