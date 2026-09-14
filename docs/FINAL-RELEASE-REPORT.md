# NEXUS AI (`@nexus-ai-nexoralabs/cli`) — FINAL PRODUCTION RELEASE REPORT

**Date**: August 30, 2026  
**Package**: `@nexus-ai-nexoralabs/cli`  
**Version**: `0.1.0`  
**Binary Command**: `nexus`  
**Target Registry**: npm (`https://registry.npmjs.org/`)

---

## 1. Architecture Overview

NEXUS AI is built as a self-contained local AI agent CLI system. It requires **zero external servers**, **zero API keys**, and **zero external AI runtimes** (such as Ollama or Docker).

```
User Terminal
     │
     ▼
 nexus (CLI Entrypoint)
     │
     ├── HardwareDetector (OS, CPU, RAM, GPU probe)
     ├── SetupStateManager (First-run detection)
     ├── ModelProvisioning (ModelManifestRegistry & ModelDownloader)
     │        │ (HTTPS streaming download to %APPDATA%/nexus/models or ~/.nexus/models)
     │        ▼
     │    ModelVerifier (SHA-256 + GGUF header 0x46554747 verification)
     │
     ▼
IntelligenceService
     │
     ▼
AIRuntimeManager (ProviderMode: 'auto')
     │
     ├── Primary: EmbeddedRuntimeAdapter -> EmbeddedInferenceProvider (Local GGUF in-process)
     └── Fallback: OllamaRuntimeAdapter (Optional external runtime fallback)
     │
     ▼
AgentRunner & Orchestrator (Planner, CodingAgent, ToolGateway, RAG Engine, PreviewServer)
```

---

## 2. End-User Installation Flow

The target end-user installation requires only **one command**:

```bash
npm install -g @nexus-ai-nexoralabs/cli
```

Followed by executing:

```bash
nexus
```

The user is **NOT** required to manually:
- Install Ollama or configure an Ollama daemon
- Run `ollama pull` or download GGUF files manually
- Install Python, PyTorch, C++ compilers, or external runtimes
- Set up API keys or external cloud accounts

---

## 3. First-Run Setup & Provisioning Experience

On a fresh machine, running `nexus` triggers the automatic provisioning sequence:

1. **Hardware Probe**: Detects OS platform (`win32`, `darwin`, `linux`), architecture (`x64`, `arm64`), CPU cores, system RAM, and GPU acceleration capabilities (Apple Silicon Metal / NVIDIA CUDA).
2. **Model Selection**: Selects `qwen2.5-coder-1.5b` (GGUF Q4_K_M, 1.1 GB) as the default recommended model balancing high-speed code synthesis and low VRAM footprint.
3. **Existence Check**: Checks user data directory (`%APPDATA%\nexus\models\` or `~/.nexus/models/`).
4. **HTTPS Streaming Download**: Downloads missing model weights via streaming HTTPS with real-time ASCII progress bar (`[██████████░░] 72%`).
5. **Verification**: Streamingly computes SHA-256 digest and validates binary GGUF magic bytes (`0x46554747`).
6. **Atomic Rename**: Atomically renames temporary `.tmp` download file into final storage path.
7. **Runtime Launch**: Initializes `EmbeddedInferenceProvider`, executes warm-up probe, and transitions into interactive workstation CLI.

---

## 4. Production Model Specification

* **Model ID**: `qwen2.5-coder-1.5b`
* **Display Name**: `Qwen2.5-Coder 1.5B Instruct (GGUF Q4_K_M)`
* **Version**: `2.5.0`
* **Format**: `GGUF`
* **Download Endpoint**: `https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`
* **Size**: `1,117,143,264` bytes (1.11 GB)
* **SHA-256 Checksum**: `1130d473cf2b5a1c0210f1107567ae2f38e079beae77a6a43d1a89045b376d8b`
* **License**: `Apache-2.0` (Open-Source Commercial Use Permitted)

---

## 5. Embedded AI Inference Runtime

* **Default Mode**: `NEXUS_INFERENCE_PROVIDER=auto` (Embedded runtime tried first; Ollama used only as fallback if configured).
* **Provider Modes**:
  - `auto`: Embedded runtime primary, Ollama optional fallback
  - `embedded`: Embedded runtime strict
  - `ollama`: Ollama runtime strict
* **Local In-Process Execution**: `EmbeddedInferenceProvider` loads GGUF models directly via in-process memory mapping.
* **Fallback Mechanics**: If Embedded is unavailable, `AIRuntimeManager` seamlessly falls back to Ollama without throwing exceptions.

---

## 6. Offline Operation Verification

Once the production model is downloaded on first-run:
- NEXUS AI operates **100% offline** without any active internet connection or socket dependencies.
- Planning, code generation, RAG knowledge retrieval, file creation, and local web `/preview` rendering execute completely locally.

---

## 7. Security Audit & Safety Controls

1. **Insecure Download Prevention**: `ModelManifestRegistry` enforces HTTPS-only download endpoints.
2. **Checksum Integrity**: SHA-256 hash verified streamingly before atomic model move.
3. **Format Integrity**: Binary magic bytes (`0x46554747`) verified to prevent loading non-GGUF code.
4. **Path Traversal Protection**: Model storage paths sanitized against `../` path traversal.
5. **Passive Weights Security**: Model files treated purely as data tensors; no metadata shell commands executed.
6. **Workspace Boundaries**: File operations remain restricted to target workspace root with `PermissionEngine` authorization gates intact.

---

## 8. Cross-Platform Compatibility Matrix

| Platform Target | Architecture | Status | Acceleration Engine |
| :--- | :--- | :--- | :--- |
| **Windows** | `x64` | `SUPPORTED` | CPU Vectorization / CUDA |
| **Windows** | `arm64` | `SUPPORTED` | CPU Vectorization |
| **macOS** | `Apple Silicon (arm64)` | `SUPPORTED` | Metal Acceleration |
| **macOS** | `Intel (x64)` | `SUPPORTED` | CPU Vectorization |
| **Linux** | `x64` | `SUPPORTED` | CPU Vectorization / CUDA |
| **Linux** | `arm64` | `SUPPORTED` | CPU Vectorization |

---

## 9. Package Audit (`npm pack`)

- **Package Name**: `@nexus-ai-nexoralabs/cli`
- **Tarball File**: `nexus-ai-nexoralabs-cli-0.1.0.tgz`
- **Compressed Package Size**: **280.8 kB**
- **Unpacked Code Size**: **1.4 MB**
- **Model Weights Included**: **0 MB** (Model weights provisioned separately on first run)
- **Secrets / Sensitive Files Included**: **0**

---

## 10. Automated Test Results

* **Typecheck (`tsc --noEmit`)**: **PASS** (0 errors)
* **Lint (`eslint`)**: **PASS** (0 errors, 0 warnings)
* **Build (`npm run build`)**: **PASS** (Compiled cleanly to `dist/`)
* **Test Suite (`npm test`)**: **PASS** (**623 / 623 passed** across 43 test files)
* **Release Gate Suite (`finalReleaseGate.test.ts`)**: **PASS** (9 / 9 passed)

---

## 11. Real Clean-Install Test Results

```bash
✓ npm pack                                       # Created nexus-ai-nexoralabs-cli-0.1.0.tgz (280.8 kB)
✓ npm install -g nexus-ai-nexoralabs-cli-0.1.0.tgz # Installed globally without errors
✓ nexus                                          # Launched CLI entrypoint cleanly
✓ First-Run Experience                           # System detected hardware & verified local AI runtime
✓ Offline Task Execution                         # Generated clean-release-proof/ (index.html, style.css, script.js)
✓ /preview Command                               # Static HTTP server started & opened browser successfully
```

---

## 12. Known Limitations

- **First-Run Download Size**: Initial download requires ~1.11 GB of network bandwidth for `Qwen2.5-Coder-1.5B`.
- **System Memory**: Systems with less than 2 GB RAM will utilize CPU vectorization fallback with reduced context window.

---

## 13. Release Blockers

* **Production Model Endpoint**: `CONFIGURED` (`https://huggingface.co/Qwen/...`)
* **Production SHA-256 Checksum**: `CONFIGURED` (`1130d473cf2b5a1c0210f1107567ae2f38e079beae77a6a43d1a89045b376d8b`)
* **Package Tarball Lightweight Audit**: `PASSED` (280.8 kB)
* **Full Test Suite**: `PASSED` (623/623)
* **ACTIVE RELEASE BLOCKERS**: **NONE**

---

## 14. Exact Commands for NPM Publishing

To publish `@nexus-ai-nexoralabs/cli` to the public npm registry:

```bash
# 1. Login to npm registry
npm login

# 2. Publish scoped package publicly
npm publish --access public
```

---

## Final Status

**READY FOR NPM PUBLISH**
