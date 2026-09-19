# Browser Agent Next — Design Specification

## Purpose

Build a model-agnostic browser runtime that converts the open, mutable web into a typed environment with explicit state, persistent identity, bounded capabilities, policy-controlled effects, strict live execution and independent verification.

The target is not a smarter click loop. It is a reusable browser operating layer for Claude, Codex, Jev, recipes, WebMCP and future agents.

## Core contracts

### State
A BrowserObservation is a scoped projection, not necessarily a full DOM mirror. It includes page identity, revision, viewport, frames, normalized elements, coverage, and optional forms/capabilities/delta.

### Identity
Persistent refs are allocated from strong identities:
- DOM: tab + frame epoch + stable element id;
- AX: tab + CDP frame id + document epoch + backend node id.

A ref never becomes another element.

### Action
Autonomous actions identify the observation and target they are based on:

```text
observedRevision + ref + typed operation
```

### Effect
Effects are modeled separately from operations. An arbitrary click may have `unknown` effect.

### Verification
A model may request verification but cannot prove success by asserting DONE.

## Trust boundary

DOM text, AX names, aria labels, network responses, console messages, WebMCP metadata/output and downloaded content are untrusted observations.

Untrusted observations can inform decisions but cannot create authorization.

## Two-phase side effects

This is an authorization structure, not a universal browser transaction:

```text
prepare → authorize → commit → verify
```

## Jev

Jev is a bounded semantic decision provider, not a browser agent.

Initial operation space:

```text
CLICK
HANDOFF_FORM
HANDOFF_VERIFY
ESCALATE
```

Jev never emits arbitrary JS/selectors, grants permissions, creates business input, or proves final task success.

## Migration

1. eval baseline
2. BrowserState IR
3. observation coverage
4. persistent refs
5. revisions + delta
6. strict executor
7. effect/authorization policy
8. Observe/Act/Extract/Verify
9. Jev shadow + fast step
10. WebMCP
11. trajectory-to-recipe compiler
12. vision fallback
