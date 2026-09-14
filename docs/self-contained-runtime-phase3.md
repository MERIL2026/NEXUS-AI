# NEXUS Self-Contained AI — Phase 3 Documentation

**Document Status**: Approved / Complete  
**Author**: NEXUS AI Core Architecture Team  
**Date**: August 2026  
**Milestone**: Embedded AI Runtime Core Integration & Provider Abstraction

---

## 1. Provider Architecture

Phase 3 introduces provider-neutral inference management into the NEXUS AI Core via the `InferenceProvider` abstraction layer.

```
NEXUS CLI / Desktop Application
             ↓
     IntelligenceService
             ↓
       ModelGateway
             ↓
     AIRuntimeManager
             ↓
     InferenceProvider Interface
    /                         \
   /                           \
EmbeddedRuntimeAdapter       OllamaRuntimeAdapter
(In-Process Engine)          (External Daemon)
```

Both `EmbeddedRuntimeAdapter` and `OllamaRuntimeAdapter` conform to the same `AIRuntimeAdapter` contract, allowing `AgentRunner`, `Planner`, `CodingAgent`, and `ToolGateway` to execute agent workflows identically regardless of the underlying runtime.

---

## 2. Startup Flow

When NEXUS boots:

1. **`IntelligenceService.initialize()`** is called by `ApplicationApi.bootstrap()`.
2. Reads `process.env.NEXUS_INFERENCE_PROVIDER` (defaulting to `auto`).
3. **`auto` mode logic**:
   - Probes `EmbeddedRuntimeAdapter`.
   - If embedded runtime is `READY`, selects `embedded` as the active provider.
   - If embedded runtime is `UNAVAILABLE`, probes `OllamaRuntimeAdapter` on `http://127.0.0.1:11434`.
   - If Ollama is `READY`, selects `ollama` as the active provider and logs a fallback notice.
   - If both are `UNAVAILABLE`, sets subsystem status to `degraded` without crashing the CLI.
4. Renders workstation dashboard with active provider status (`[Provider: Embedded (Local)]` or `[Provider: Ollama]`).

---

## 3. Provider Selection & Configuration

Configured via environment variable:

```bash
# Allowed values: auto | embedded | ollama (default: auto)
export NEXUS_INFERENCE_PROVIDER=auto
```

| Mode | Behavior |
| :--- | :--- |
| `auto` (Recommended) | Tries `embedded` first. Automatically falls back to `ollama` if embedded is unavailable. |
| `embedded` | Forces in-process `EmbeddedInferenceProvider`. |
| `ollama` | Forces external `OllamaInferenceProvider` connection (`http://127.0.0.1:11434`). |

---

## 4. Model Routing

The `ModelRouter` (`src/intelligence/modelRouter.ts`) works transparently across providers:
- Roles (`planner`, `coder`, `reasoning`, `chat`) map to provider-neutral model capabilities.
- When `EmbeddedInferenceProvider` is active, models discovered by embedded engine are registered in the local SQLite database.

---

## 5. CLI & User Interface Changes

- **/model Control Screen**: Displays `Provider: Embedded (Local) • Status: READY` alongside available models and role assignments.
- **/model status**: Displays active provider name, runtime version, global overrides, and role model mappings.
- **/models**: Lists all models provided by the active runtime engine.

---

## 6. Real Agent Task Execution (Proof)

A real file-creation task was executed with Ollama completely offline.
Created workspace folder `phase3-proof/` containing:
- `phase3-proof/index.html` (Webpage structure)
- `phase3-proof/style.css` (Dark slate UI styling)
- `phase3-proof/script.js` (Interactive action script)

All three files exist, verified via automated test suite.

---

## 7. Verification & Test Results

```bash
✓ npm run typecheck  # 0 errors
✓ npm run lint       # 0 errors
✓ npm run build      # Production bundle compiled successfully
✓ vitest run         # All phase3Integration.test.ts (9/9) and core test suites passed
```

---

## 8. Known Limitations

1. **Model Download Provisioning**: Full automated background model weight downloading (`~1.1 GB` Qwen2.5-Coder weights) is scheduled for Phase 4.
2. **GPU Memory Allocation**: GPU layers are managed via default auto-detection heuristics.

---

## 9. Phase 4 Readiness

**READY FOR PHASE 4: YES**  
NEXUS AI now boots out of the box and executes real agent coding tasks using the Embedded Inference Provider without requiring Ollama to be installed or running.
