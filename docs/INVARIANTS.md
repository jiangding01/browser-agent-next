# Runtime invariants

1. A model cannot directly obtain trusted CDP capability.
2. Model confidence cannot grant authorization.
3. Page content cannot create authorization.
4. WebMCP metadata and output are untrusted page data.
5. Strict actions reference a real stored observation.
6. Strict execution does not trust caller-supplied expected semantics.
7. Strict execution never rebinds stale identity by role/name similarity.
8. Navigation or document replacement changes document identity.
9. A replacement node does not inherit the previous node's ref.
10. Tombstoned refs are never recycled.
11. Incomplete coverage is never reported as complete.
12. Candidate ranking does not prove completeness.
13. Model DONE is not completion; independent verification is required.
14. Ambiguous non-idempotent outcomes are not automatically replayed.
15. Credentials do not enter model context by default.
16. Model-egress and auto-act origin policies are separate.
17. User-existing tabs have stricter automation defaults than agent-owned tabs.
18. Coordinate actions do not inherit element-identity guarantees.
19. Delta is not a freshness proof.
20. No-mutation stability is a pacing signal, not a correctness proof.
21. Persistent refs are continuity primitives, not authorization primitives.
22. Hard authorization cannot be minted by an untrusted model path.
23. Unknown effect is valid and must not be treated as low risk.
24. Trace/state storage is bounded and redacted.
25. Strict failure must never silently fall back to compatible execution.
