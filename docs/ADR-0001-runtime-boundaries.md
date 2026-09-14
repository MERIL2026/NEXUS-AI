# ADR-0001: System Architecture & Runtime Boundaries

- **Status**: Approved
- **Date**: 2026-08-16
- **Context**: NEXUS AI requires a clear runtime architecture boundary for Windows desktop operation that isolates local Ollama inference, tool execution, knowledge storage, and user interface.

## Decision

1. **Subsystem Layering**:
   NEXUS AI follows a 7-layer architecture defined in N08:
   - **Experience Layer**: Desktop UI / Client views
   - **Application API Layer**: Gateway, request validation, health monitoring, streaming contracts
   - **Orchestration Layer**: Router, planner, context manager, agent runtime, verifier
   - **Intelligence Layer**: Ollama inference provider adapter, model registry
   - **Knowledge & Memory Layer**: Ingestion, document pipeline, vector storage, memory
   - **Tools Layer**: File, search, terminal, code execution connectors with permission enforcement
   - **Runtime & Storage Layer**: Local relational database, filesystem workspace, logs

2. **Model Gateway Isolation**:
   No UI component or agent tool may call Ollama directly. All model invocations must pass through the `Intelligence` model gateway interface.

3. **Tool Gateway Security**:
   All filesystem and terminal actions requested by agents must pass through the `Tools` policy engine and permission checks.

4. **Persistence Isolation**:
   Local relational persistence (SQLite) and workspace files are managed strictly through the `Storage` service abstraction.

## Consequences

- Prevents tight coupling between UI and specific AI model runtimes.
- Ensures all destructive or high-risk operations pass through policy validation.
- Enables mock-driven testing of subsystems prior to full integration.
