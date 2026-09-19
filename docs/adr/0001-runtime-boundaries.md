# ADR-0001: Runtime boundaries

- Status: Accepted
- Date: 2026-09-19

## Decision

Separate six responsibilities:

1. Planner — defines the micro-goal.
2. Decision provider — selects from bounded choices.
3. Policy engine — decides whether execution is allowed.
4. Strict executor — proves the target is still the observed target.
5. Browser kernel — interacts with Chrome.
6. Verifier — independently proves the result.

The MCP server is an adapter, not the runtime kernel.
