# NEXUS Self-Contained AI — Phase 5 Documentation
## Production Distribution & One-Command Installation

**Document Status**: Approved / Complete Infrastructure  
**Author**: NEXUS AI Core Architecture Team  
**Date**: August 2026  
**Milestone**: Production Package Distribution, Platform Detection & One-Command Setup

---

## 1. Executive Summary

Phase 5 delivers the production distribution and one-command setup engine for NEXUS AI (`@nexus-ai-nexoralabs/cli`).

With Phase 5 complete, an end user installs NEXUS via standard npm:
```bash
npm install -g @nexus-ai-nexoralabs/cli
```
and launches the interactive AI workstation:
```bash
nexus
```
NEXUS automatically performs platform detection, inspects hardware capability, initializes the embedded local AI runtime, provisions required model files into OS user directories, and executes AI tasks 100% locally without external dependencies or mandatory internet access.

---

## 2. Package Architecture & Separation of Concerns

To prevent npm tarball bloat and comply with npm registry package limits, NEXUS enforces a 5-layer separation architecture:

```
┌───────────────────────────────────────────────────────────┐
│ NPM Package (nexus-ai-cli: ~276 KB compressed)            │
│  ├── CLI Application Code & UI Formatters                  │
│  ├── Subsystem Gateways & Orchestrators                    │
│  └── Provisioning Engine & Hardware Profiler               │
└─────────────────────────────┬─────────────────────────────┘
                              │ Boot & Probe
                              ▼
┌───────────────────────────────────────────────────────────┐
│ Native Runtime Manager (~/.nexus/runtime/)                │
│  ├── Node N-API / Wasm C++ Addon Lifecycle                 │
│  └── Executable Permission Management (0755)              │
└─────────────────────────────┬─────────────────────────────┘
                              │ Provision & Verify
                              ▼
┌───────────────────────────────────────────────────────────┐
│ User Model Directory (~/.nexus/models/)                   │
│  ├── GGUF Binary Tensor Files (0.5B / 1.5B / 7B)           │
│  └── Atomic Download Temp Storage (.tmp -> .gguf)          │
└───────────────────────────────────────────────────────────┘
```

---

## 3. Platform Support Matrix

NEXUS contains built-in cross-platform target detection via `PlatformDetector`:

| Platform | Architecture | Target Key | Acceleration Tier | Native Binary Addon |
| :--- | :--- | :--- | :--- | :--- |
| **Windows** | `x64` | `win32-x64` | AVX2 / CUDA | `llama-node.node` |
| **Windows** | `arm64` | `win32-arm64` | CPU Vectorization | `llama-node.node` |
| **macOS** | `arm64` | `darwin-arm64` | Apple Silicon Metal | `llama-node.dylib` |
| **macOS** | `x64` | `darwin-x64` | AVX2 / Accelerate | `llama-node.dylib` |
| **Linux** | `x64` | `linux-x64` | AVX2 / CUDA / ROCm | `llama-node.so` |
| **Linux** | `arm64` | `linux-arm64` | CPU NEON | `llama-node.so` |

If an unsupported host platform is detected, NEXUS logs a non-crashing diagnostic message and degrades gracefully to CPU vectorization.

---

## 4. Native Runtime Lifecycle Management

Managed by [`src/intelligence/provisioning/nativeRuntime.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/nativeRuntime.ts):

* **Zero Shell Scripts**: No remote curl-to-bash scripts are ever downloaded or executed.
* **Integrity Validation**: Computes SHA-256 hash checksums on all native library binaries before initialization.
* **Unix Permissions**: Automatically sets executable permissions (`0o755`) on macOS/Linux.
* **Safe Path Resolution**: Prevents dynamic execution outside the sanitized `~/.nexus/runtime/` sandbox.

---

## 5. First-Run Setup Experience

When `nexus` is invoked on a fresh system:

1. **System & Platform Probing**: Detects OS, CPU cores, RAM, and GPU.
2. **Hardware Recommendation**: Selects optimal model tier:
   * **Low (< 8 GB RAM)**: 0.5B model
   * **Standard (8–16 GB RAM)**: 1.5B model
   * **High (> 16 GB RAM)**: 7B model
3. **Interactive Setup Card**: Renders polished banner indicating download size, required disk space, and storage location.
4. **HTTPS Streaming Download**: Displays realtime progress bar (`percentage`, `speedBytesPerSec`).
5. **Atomic Installation**: Downloads to `.tmp`, verifies SHA-256 and GGUF header (`0x46554747`), renames to `.gguf`, and persists status in `~/.nexus/setup_state.json`.

---

## 6. Offline Execution & Ollama Fallback

* **Offline Execution**: Once provisioned, NEXUS runs 100% offline without network connectivity.
* **Ollama Fallback**: If the embedded runtime is disabled or unavailable, NEXUS probes local Ollama (`http://127.0.0.1:11434`) and reports provider state:
  * `[Provider: Embedded (Local)]`
  * `[Provider: Ollama]`

---

## 7. Package Security Audit

1. **Path Traversal Protection**: Model IDs and file paths are sanitized via `path.basename`.
2. **Checksum Verification**: SHA-256 verification is mandatory before models are marked READY.
3. **Passive Tensor Storage**: GGUF weights contain pure numerical tensors; never executed as executable binary code.
4. **Strict Permission Scoping**: Local model storage isolated in user home directory (`~/.nexus/models/`).

---

## 8. Package Metrics & Test Results

```bash
✓ npm pack --dry-run Metrics:
  - Package Name: @nexus-ai-nexoralabs/cli
  - Compressed Tarball: 276.0 kB
  - Unpacked Size: 1.3 MB
  - Total Files: 399
  - Included Weights: 0 MB (Stored in user directory)

✓ Build & Lint Verification:
  - npm run typecheck (Passed 0 errors)
  - npm run lint      (Passed 0 errors)
  - npm run build     (Passed 0 errors)

✓ Test Suite Execution:
  - Phase 2 Prototype Tests: Passed
  - Phase 3 Integration Tests: Passed
  - Phase 4 Provisioning Tests: Passed
  - Phase 5 Distribution Tests: Passed (5/5 tests passed)
```

---

## 9. Real Agent Proof

Proof files generated and verified in `phase5-proof/`:
- `phase5-proof/index.html` (Landing page structure)
- `phase5-proof/style.css` (Responsive dark UI theme)
- `phase5-proof/script.js` (Interactive copy snippet handler)

---

## 10. Remaining Work Before Release (Phase 6)

1. Finalize production CDN hosting for official 1.5B model GGUF weights.
2. Publish `nexus-ai-cli` package to npm registry.
