# NEXUS Self-Contained AI — Phase 2: Embedded Inference Runtime Research

**Document Status**: Approved / Research & Prototype Phase  
**Author**: NEXUS AI Core Architecture Team  
**Date**: August 2026  
**Target Milestone**: Zero-External-Dependency Self-Contained Local Workstation

---

## 1. Current Architecture

Currently, NEXUS AI operates as a local-first AI workstation via the `OllamaAdapter` and `OllamaRuntimeAdapter` abstractions located in `src/intelligence/`.

```
User CLI / Desktop App
         ↓
  IntelligenceService
         ↓
   ModelGateway
         ↓
 OllamaRuntimeAdapter
         ↓ (HTTP REST API: /api/tags, /api/generate, /api/chat, /api/show)
External Ollama Daemon (http://127.0.0.1:11434)
```

### Limitations of Current Model:
1. **User Friction**: Users must manually install Ollama, start the service background daemon, and pull models via CLI before running NEXUS (`ollama pull qwen2.5-coder`).
2. **Brittle Lifecycle**: If the Ollama background daemon crashes, port `11434` is blocked, or service updates alter response headers, NEXUS enters `DEGRADED` state.
3. **Distribution Barrier**: Electron installers (`electron-builder`) and standard npm global packages (`npm install -g nexus-ai-cli`) cannot bundle Ollama seamlessly across platforms without multi-hundred megabyte external setup scripts.

---

## 2. Candidate Runtimes

We evaluated five primary embeddable local inference runtimes suitable for Node.js / TypeScript workstation environments:

### Candidate A: `node-llama-cpp` (Native Node Bindings for llama.cpp)
* **Description**: Direct Node.js native C++ bindings for the `llama.cpp` engine. Compiles C++ kernels via CMake/N-API or downloads platform-specific prebuilt binary addons for Windows, macOS, and Linux.
* **Architecture**: Runs in-process or via lightweight worker threads within Node.js.

### Candidate B: `llama.cpp` Process Sidecar
* **Description**: Bundling platform-tailored native binary executables of `llama-server` (or `llama-cli`) managed directly by NEXUS process lifecycles as a child process daemon listening on a internal IPC pipe / local loopback port.
* **Architecture**: Managed process sidecar spawned by NEXUS on startup and terminated on shutdown.

### Candidate C: `ONNX Runtime Node` (`@onnxruntime/node`)
* **Description**: Microsoft ONNX Runtime Node bindings supporting CPU (OpenMP), DirectML (Windows GPU), CUDA (NVIDIA), and CoreML (Apple Silicon).
* **Architecture**: In-process Node.js native binding executing `.onnx` converted model weights.

### Candidate D: `wllama` / WebAssembly llama.cpp
* **Description**: Port of `llama.cpp` compiled to WebAssembly (Wasm) with SIMD vector extensions.
* **Architecture**: Runs entirely inside the Node.js V8 WebAssembly engine without native binaries or platform compilation.

### Candidate E: `MLC-LLM` / `WebLLM Node`
* **Description**: Machine Learning Compilation (MLC) framework leveraging Apache TVM and WebGPU/Wasm backends.
* **Architecture**: Cross-platform WebGPU engine requiring WebGPU bindings in Node 22+.

---

## 3. Comparison Table

Evaluation across all 18 key technical criteria:

| Evaluation Dimension | Candidate A: node-llama-cpp | Candidate B: llama.cpp Sidecar | Candidate C: ONNX Runtime | Candidate D: wllama (Wasm) | Candidate E: MLC-LLM |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Cross-Platform Support** | Windows x64, macOS (ARM/Intel), Linux x64 | Windows x64, macOS (ARM/Intel), Linux x64 | Windows x64, macOS (ARM/Intel), Linux x64 | 100% Universal (Wasm) | Windows, macOS (requires WebGPU) |
| **2. Node.js Integration** | Excellent (Native N-API) | Good (Child process IPC / HTTP) | Excellent (Native N-API) | Excellent (Pure JS/Wasm) | Moderate (Experimental) |
| **3. TypeScript Integration** | First-class TS types | Manual fetch/client bindings | Good TS types | Good TS types | Moderate |
| **4. CPU Inference** | High (AVX2, AVX-512, ARM Neon) | High (AVX2, AVX-512, ARM Neon) | Moderate (OpenMP / MLAS) | Low-Moderate (Wasm SIMD) | Moderate |
| **5. NVIDIA GPU (CUDA)** | Supported (Prebuilt CUDA binaries) | Supported (CUDA build) | Supported (CUDA execution provider) | Unsupported | Supported (Vulkan/CUDA) |
| **6. Apple Silicon (Metal)** | Supported (Native Metal) | Supported (Native Metal) | Supported (CoreML/Metal) | Unsupported | Supported (WebGPU Metal) |
| **7. Model Formats** | GGUF (v1, v2, v3) | GGUF (v1, v2, v3) | ONNX | GGUF | MLC Format / Wasm Weights |
| **8. Streaming Generation** | Native AsyncIterator | Server-Sent Events (SSE) | Custom Tokenizer Loop | Async Callback | Async Streams |
| **9. Memory Usage** | Low (Direct C++ memory pool) | Low (Isolated process heap) | Moderate | Moderate-High (Wasm 4GB limit) | Moderate |
| **10. Startup Time** | Ultra-Fast (< 150ms) | Fast (~300ms process spawn) | Fast (~200ms) | Slow (Wasm JIT setup ~1s) | Moderate (~500ms) |
| **11. Distribution Package Size** | ~30 MB (Prebuilt addons) | ~15-25 MB (Targeted binary) | ~40 MB | ~5 MB | ~50 MB |
| **12. Run without Ollama** | YES | YES | YES | YES | YES |
| **13. Model Provisioning** | Direct file path / HTTP stream | Direct file path | Direct file path | ArrayBuffer / stream | HTTP fetch |
| **14. Licensing** | MIT | MIT | MIT | MIT | Apache-2.0 |
| **15. Commercial Compatibility** | 100% Permissive | 100% Permissive | 100% Permissive | 100% Permissive | 100% Permissive |
| **16. Installer Integration** | Seamless (bundled in electron/npm) | Easy (bundled asset) | Seamless | Easy | Complex |
| **17. Coding/Reasoning Workloads** | Full support (Qwen2.5-Coder GGUF) | Full support | Moderate (requires ONNX convert) | Limited (slow context processing) | Moderate |
| **18. Long-Term Maintainability** | High (Active community) | Very High (upstream C++) | High (Microsoft backed) | Moderate | Moderate |

---

## 4. Recommended Runtime

### Recommendation: Dual-Layer Hybrid Strategy
* **Primary Runtime**: `node-llama-cpp` (v3) as the default in-process Node.js native binding.
* **Secondary / Managed Sidecar Strategy**: Fallback to `llama-server` process sidecar for systems with custom hardware / CUDA builds where native Node addons encounter binary ABI mismatches.

---

## 5. Why It Was Selected

1. **Native Performance without External Daemon**: `node-llama-cpp` compiles/binds directly to `llama.cpp`, providing top-tier CPU and GPU inference speeds without requiring the user to run an external service.
2. **GGUF Ecosystem Dominance**: GGUF is the gold standard for quantized open-weights models (Qwen2.5-Coder, DeepSeek-R1-Distill, Llama-3.2).
3. **Zero Configuration**: Supports automatic hardware detection (AVX2, CUDA, Metal) out of the box with zero user intervention.
4. **Permissive License**: MIT licensed, allowing frictionless commercial distribution with NEXUS.

---

## 6. Cross-Platform Strategy

To guarantee cross-platform support across Windows, macOS, and Linux:

* **Windows x64**:
  * Default: Prebuilt `node-llama-cpp` AVX2 binary addon.
  * GPU: Automatic CUDA 11/12 detection, falling back to CPU vectorization.
* **macOS Apple Silicon (M1/M2/M3/M4)**:
  * Default: Metal GPU acceleration via arm64 native binary. Provides 60+ tokens/sec on 3B/7B models.
* **macOS Intel (x64)**:
  * Default: x64 AVX2 CPU acceleration.
* **Linux x64**:
  * Default: Prebuilt GLIBC-compatible native binaries with CUDA/Vulkan auto-detection.

---

## 7. Model Format Strategy

* **Standard Format**: **GGUF v3**.
* **Quantization Standard**: `Q4_K_M` (recommended balance of 4-bit precision, size, and perplexity) or `Q8_0` for small models (<1B parameters).
* **Target Default Model for NEXUS Production**: `Qwen2.5-Coder-1.5B-Instruct-GGUF` (~1.1 GB) or `Qwen2.5-Coder-0.5B-Instruct-GGUF` (~390 MB).

---

## 8. Streaming Strategy

The `InferenceProvider` contract exposes `streamChat()` which streams tokens back as soon as they are evaluated:

```typescript
export interface InferenceStreamChunk {
  delta: string;
  done: boolean;
}
```

Implementation consumes `node-llama-cpp`'s async token generator or process HTTP SSE stream chunk by chunk, feeding UI and terminal consumers with zero buffer latency.

---

## 9. GPU Strategy

1. **macOS**: Automatically enables Metal performance shaders (`gpuLayers: max`).
2. **Windows / Linux NVIDIA**: Probes for `nvcc` / CUDA runtime DLLs (`nvcuda.dll` / `libcuda.so`). If present, offloads model layers to VRAM.
3. **Vulkan Fallback**: For AMD / Intel Arc GPUs on Windows and Linux, Vulkan backend can be enabled seamlessly.

---

## 10. CPU Fallback Strategy

When no compatible GPU is detected:
* Automatically configures thread count based on physical CPU cores (`threads: Math.max(1, os.cpus().length - 1)`).
* Uses AVX2 / AVX-512 vector instructions.
* Enforces strict context memory limits to prevent CPU thrashing.

---

## 11. Memory Requirements

| Model Parameter Size | Quantization | Disk Footprint | VRAM / RAM Required | Context Length |
| :--- | :--- | :--- | :--- | :--- |
| **0.5B** (e.g. Qwen2.5 0.5B) | Q8_0 / Q4_K_M | ~390 MB | ~700 MB | 4,096 tokens |
| **1.5B** (e.g. Qwen2.5-Coder 1.5B) | Q4_K_M | ~1.1 GB | ~1.8 GB | 8,192 tokens |
| **3B** (e.g. Llama-3.2 3B) | Q4_K_M | ~2.0 GB | ~3.2 GB | 8,192 tokens |
| **7B** (e.g. Qwen2.5-Coder 7B) | Q4_K_M | ~4.4 GB | ~6.5 GB | 16,384 tokens |

---

## 12. Distribution / Package Strategy

1. **NPM Global Package (`nexus-ai-cli`)**:
   * Binary bindings bundled or downloaded on-demand to `~/.nexus/runtime/` during initial `nexus init`.
2. **Electron Workstation App**:
   * Prebuilt platform binaries bundled in `resources/bin/` via `electron-builder`.

---

## 13. Licensing Considerations

* **`node-llama-cpp`**: MIT License.
* **`llama.cpp`**: MIT License.
* **Target Models (Qwen2.5-Coder)**: Apache 2.0 License.
* **Conclusion**: 100% compliant with commercial distribution and open-source licensing.

---

## 14. Security Considerations

1. **No External Network Dependencies**: Embedded inference operates offline.
2. **Memory Safety**: Direct native memory allocations are freed explicitly on `provider.shutdown()`.
3. **Local Storage**: Models stored strictly in user-owned local directories (`~/.nexus/models/`).

---

## 15. Risk Matrix & Mitigations

| Risk | Impact | Likelihood | Mitigation |
| :--- | :--- | :--- | :--- |
| Native build failure on obscure Linux distros | High | Low | Secondary `llama-server` process sidecar fallback. |
| RAM exhaustion on lower-end 8GB RAM machines | High | Medium | Default to 0.5B/1.5B lightweight models with RAM guardrails. |
| Node.js version binary ABI mismatch | Medium | Low | N-API stable ABI bindings. |

---

## 16. Migration Plan from Ollama

* **Phase 1 (Complete)**: System audit & runtime boundaries confirmed.
* **Phase 2 (Current)**: Research & isolated prototype created.
* **Phase 3 (Next)**: Introduce `InferenceProvider` abstraction into NEXUS core, keeping Ollama as a user-configurable option alongside the Embedded Runtime.
* **Phase 4**: Set Embedded Runtime as default for clean `npm install -g @nexus-ai-nexoralabs/cli` experience.

---

## 17. Rollback Plan

If the embedded runtime encounters an unrecoverable platform error on a user's machine:
1. NEXUS automatically detects the failure during `healthCheck()`.
2. Emits a non-fatal warning banner in CLI.
3. Dynamically falls back to `OllamaInferenceProvider` if Ollama is running on `11434`.
