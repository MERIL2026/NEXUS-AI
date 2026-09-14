# NEXUS AI Phase 1 Technical Audit: Ollama Dependency & Model Integration

**Document Status**: Approved / Complete Audit  
**Author**: NEXUS AI Core Architecture Team  
**Date**: August 2026  
**Target Goal**: Comprehensive dependency mapping prior to Phase 3 embedded runtime integration.

---

## 1. Executive Summary

This document presents the Phase 1 Technical Audit of NEXUS AI's existing model execution pipeline, detailing every architectural touchpoint, API endpoint, configuration site, and system boundary associated with Ollama and external LLM inference.

**Key Audit Findings**:
1. NEXUS currently relies on Ollama via direct HTTP REST calls (`http://127.0.0.1:11434`) using standard Node.js `fetch`. No third-party npm client library (like `ollama-js`) is imported.
2. Abstraction layers (`AIRuntimeAdapter`, `ModelRegistry`, `ModelRouter`, `ModelGateway`) already decouple higher-level agent logic from low-level inference implementations.
3. Replacing or augmenting Ollama with an embedded runtime requires updating only `IntelligenceService` and `AIRuntimeAdapter` implementations. The Planner, Coding Agent, Tool Execution Engine, and UI layers do not need changes.

---

## 2. Deep-Dive Audit Findings (13 Requested Areas)

### 1. Files Importing or Communicating with Ollama
- `src/intelligence/ollamaAdapter.ts`: Core HTTP REST client.
- `src/intelligence/runtime/ollamaRuntimeAdapter.ts`: Implements `AIRuntimeAdapter` over `OllamaAdapter`.
- `src/intelligence/runtime/runtimeManager.ts`: Manages health probes, discovery, and warmup.
- `src/intelligence/index.ts`: `IntelligenceService` entrypoint instantiating the adapter.
- `src/intelligence/modelGateway.ts`: Dispatches inference requests from agents.
- `src/intelligence/modelRegistry.ts`: Syncs models discovered from Ollama `/api/tags` into SQLite.
- `src/intelligence/modelRouter.ts`: Routes task types (`planner`, `coder`, `reasoner`, `chat`) to Ollama model names.
- `src/cli/uiFormatters.ts`: Formats Ollama offline warning banners (`renderOllamaMissingBanner`).
- `src/cli/commands/modelCommand.ts`: `/model` CLI command handler.
- `src/cli/main.ts`: CLI startup logic performing runtime health probes.
- `src/api/server.ts`: REST API gateway exposing runtime status.
- `src/__tests__/*`: Test suites (`ollamaAdapter.test.ts`, `p7bRuntimeManagement.test.ts`, `p7cFirstRunExperience.test.ts`, `modelControlP7G.test.ts`).

### 2. Ollama API Endpoints Used
- `GET /api/version`: Health checks and version detection.
- `GET /api/tags`: Model discovery and metadata parsing.
- `POST /api/generate`: Single prompt completion (streaming and non-streaming).
- `POST /api/chat`: Multi-turn role-based chat completions.
- `POST /api/show`: Detailed model parameter inspection.

### 3. Model ID Configuration Sites
- `src/intelligence/modelRouter.ts`: Priority list fallback configurations (`qwen2.5-coder:7b`, `qwen2.5-coder:1.5b`, `llama3.2:3b`, `qwen2.5:0.5b`).
- `src/storage/migrations/002_model_registry.sql`: Database migration populating default model entries in SQLite `models` table.
- `src/cli/commands/modelCommand.ts`: Runtime user configuration via `/model set <role> <modelId>`.

### 4. Model Discovery Mechanism
- Triggered during `IntelligenceService.initialize()`.
- `OllamaAdapter.discoverModels()` requests `GET /api/tags`.
- Models are normalized into `OllamaModelItem[]` and upserted into SQLite via `ModelRegistry.syncDiscoveredModels()`.

### 5. Model Routing Mechanics
- Handled by `ModelRouter` in `src/intelligence/modelRouter.ts`.
- Evaluates task requirements (`planner`, `coder`, `reasoner`, `chat`, `fast`) against installed model capabilities, family names, parameter counts, and quantization levels.

### 6. Role Selection (Planner, Coder, Reasoner, Chat)
- `planner`: Selected via `selectModelForTask('planner')` -> favors `qwen2.5-coder:7b`, `llama3.2:3b`.
- `coder`: Selected via `selectModelForTask('coder')` -> favors `qwen2.5-coder:7b`, `qwen2.5-coder:1.5b`.
- `reasoner`: Selected via `selectModelForTask('reasoner')` -> favors `deepseek-r1`, `qwen2.5`.
- `chat`: Selected via `selectModelForTask('chat')` -> defaults to active user preference.

### 7. Environment Variables
- `OLLAMA_HOST`: Target URL for Ollama service (default: `http://127.0.0.1:11434`).
- `NEXUS_DEFAULT_MODEL`: Optional model name override.
- `NEXUS_LOG_LEVEL`: Log level setting.

### 8. NPM Dependencies
- **No external npm package is used for Ollama API calls**. Calls use native Node.js 20+ `fetch`.

### 9. Streaming vs Non-Streaming Inference
- **Non-Streaming**: `stream: false` sent to `/api/generate`. Full JSON body read on completion.
- **Streaming**: `stream: true` sent to `/api/generate`. Uses `res.body.getReader()`, decodes UTF-8 buffers into line-delimited JSON chunks, and passes `{ delta, done }` to callback.

### 10. Timeouts & Fallbacks
- Health checks timeout at 3,000ms.
- Non-streaming requests timeout at 30,000ms via `AbortController`.
- Streaming requests timeout at 60,000ms with inactivity reset timers.
- If Ollama is offline, system transitions to `DEGRADED` status mode.

### 11. Model Control System (/model)
- `/model status`: Queries `IntelligenceService.getStatus()` -> reads cached health.
- `/model list`: Queries `ModelRegistry.getAvailableModels()`.
- `/model set <role> <modelId>`: Updates active assignment in SQLite.
- `/model pull <modelId>`: Advises running `ollama pull <modelId>` in terminal.

### 12. Test Dependencies
- Tests mock `OllamaAdapter` methods (`checkHealth`, `discoverModels`, `generate`).
- Integration tests verify `DEGRADED` behavior by attempting connections to dummy port `59999`.

### 13. CLI Startup Flow
```
cli/main.ts
   ↓
IntelligenceService.initialize()
   ↓
AIRuntimeManager.getHealth(true)
   ↓
OllamaRuntimeAdapter.checkHealth() -> GET /api/version
   ↓
[READY] -> Sync Models -> Render Ready Status
[OFFLINE] -> Render DEGRADED Banner (renderOllamaMissingBanner)
```

---

## 3. Required Technical Report Sections

### CURRENT ARCHITECTURE
NEXUS AI follows a 7-layer architecture (ADR-0001). Model execution resides in the **Intelligence Layer**, isolated from UI, Orchestration, Tools, and Persistence layers.

### CURRENT DEPENDENCIES
- Hard dependency on an external Ollama daemon running on loopback port `11434`.
- No third-party npm client dependencies (uses native `fetch`).

### MODEL FLOW
`Agent Core -> ModelGateway -> AIRuntimeManager -> OllamaRuntimeAdapter -> OllamaAdapter -> HTTP -> Ollama Daemon`

### OLLAMA INTEGRATION
REST API over HTTP (`/api/version`, `/api/tags`, `/api/generate`, `/api/chat`, `/api/show`).

### MODEL ROUTING
Capabilities-based dynamic routing handled by `ModelRouter` based on discovered models in SQLite repository.

### CLI STARTUP FLOW
Probes Ollama health during startup. If unreachable, CLI operates in `DEGRADED` mode with interactive terminal banners.

### FILES THAT MUST CHANGE FOR EMBEDDED RUNTIME
1. `src/intelligence/index.ts`: Instantiate `EmbeddedInferenceProvider` or hybrid manager.
2. `src/intelligence/runtime/runtimeManager.ts`: Support embedded runtime health checks and model loading.
3. `src/cli/commands/modelCommand.ts`: Support embedded model management and downloading.
4. `src/cli/uiFormatters.ts`: Update status banners to reflect self-contained embedded engine status.

### RISKS
1. Memory footprint management on 8GB RAM host systems.
2. Platform-specific native binary addon compilation across diverse Linux distributions.

### RECOMMENDED SELF-CONTAINED ARCHITECTURE
Introduce `InferenceProvider` factory allowing seamless switching between `EmbeddedInferenceProvider` (default) and `OllamaInferenceProvider` (optional user override).
