# NEXUS Self-Contained AI — Phase 4 Documentation
## Production Model Provisioning & First-Run Setup Infrastructure

**Document Status**: Approved / Complete Infrastructure  
**Author**: NEXUS AI Core Architecture Team  
**Date**: August 2026  
**Milestone**: Production Model Provisioning, Verification & First-Run Setup Engine

---

## 1. Executive Summary

Phase 4 establishes the production-grade model provisioning, integrity verification, cross-platform storage, hardware resource profiling, and first-run setup infrastructure for NEXUS AI.

When a user installs NEXUS (`npm install -g @nexus-ai-nexoralabs/cli`) and launches `nexus` for the first time, NEXUS automatically checks whether an embedded AI runtime and verified local model exist. If missing, it provides a safe, interactive first-run setup without downloading anything without explicit user consent.

---

## 2. Model Manifest System

Defined in [`src/intelligence/provisioning/modelManifest.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/modelManifest.ts).

Manifest structure contains:
- `id`: Unique model identifier (e.g. `qwen2.5-coder-1.5b`)
- `displayName`: Human-readable name
- `version`: Version string
- `format`: `gguf` binary format
- `downloadUrl`: **HTTPS-only** download URL
- `sizeBytes`: File size in bytes
- `sha256`: SHA-256 hash checksum
- `capabilities`: Capability list (`code-synthesis`, `planning`, `chat`)
- `minimumRamMb` / `recommendedRamMb`: System memory bounds
- `tier`: `low` | `standard` | `high`
- `license`: Open-source license details (`Apache-2.0` / `MIT`)

---

## 3. Model Storage Strategy

Defined in [`src/intelligence/provisioning/modelStorage.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/modelStorage.ts).

Model files are **NEVER** stored inside the npm package directory. They are stored in OS-appropriate user data directories:

* **Windows**: `%APPDATA%\nexus\models\` (or `%LOCALAPPDATA%\nexus\models\`)
* **macOS**: `~/Library/Application Support/nexus/models/`
* **Linux**: `~/.nexus/models/`

Strict path sanitization isolates model paths and prevents directory traversal attacks.

---

## 4. Model Verification System

Defined in [`src/intelligence/provisioning/modelVerifier.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/modelVerifier.ts).

Before loading any model into the inference engine, NEXUS executes a 5-point verification check:

1. **Existence**: Verifies file exists on disk.
2. **Size Validation**: Compares exact file byte size.
3. **Format Integrity**: Validates GGUF magic binary header (`0x46554747` -> ASCII `"GGUF"`).
4. **SHA-256 Checksum**: Streaming SHA-256 hash calculation compared against manifest.
5. **Runtime Compatibility**: Verifies CPU/GPU execution compatibility.

---

## 5. Model Downloader & Atomic Installation

Defined in [`src/intelligence/provisioning/modelDownloader.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/modelDownloader.ts).

* **HTTPS Enforcement**: Blocks insecure HTTP URLs and non-HTTPS redirects.
* **Streaming Progress**: Emits realtime progress callback (`downloadedBytes`, `totalBytes`, `percentage`, `speedBytesPerSec`).
* **Cancellation Support**: Listens to `AbortSignal` for clean immediate termination.
* **Atomic Installation**: Downloads to `.tmp` file first. Renames atomically (`fs.renameSync`) to `.gguf` only after full SHA-256 and header verification passes.
* **Cleanup**: Automatically deletes incomplete or corrupted temp files on failure.

---

## 6. Hardware Capability Detection & Recommendation Engine

* [`src/intelligence/provisioning/hardwareDetector.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/hardwareDetector.ts): Detects OS platform, architecture, CPU cores, total RAM, free RAM, storage space, and Metal/CUDA GPU availability.
* [`src/intelligence/provisioning/modelSelector.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/modelSelector.ts): Recommends optimal model tier:
  * **Low Tier (< 8 GB RAM)**: 0.5B lightweight model (`qwen2.5-0.5b`).
  * **Standard Tier (8 - 16 GB RAM)**: 1.5B coding model (`qwen2.5-coder-1.5b`).
  * **High Tier (> 16 GB RAM)**: 7B advanced model (`qwen2.5-coder-7b`).

---

## 7. Persistent Setup State

Managed via [`src/intelligence/provisioning/setupState.ts`](file:///c:/Users/ASUS/Desktop/NEXUX%20AI/src/intelligence/provisioning/setupState.ts).

Persists setup status in `~/.nexus/setup_state.json`:
- `runtimeReady: true`
- `modelInstalled: true`
- `modelVerified: true`
- `activeModelId`
- `installedPath`
- `lastVerifiedAt`

On subsequent launches, NEXUS detects existing valid models instantly and bypasses first-run prompts.

---

## 8. CLI Command Enhancements

* `/model`: Displays Model Control Screen with active provider, model status, and role assignments.
* `/models`: Lists all available local and manifest models.
* `/model info <id>`: Displays model metadata card, tier, size, license, and installation status.
* `/model verify <id>`: Manually triggers SHA-256 and format verification.
* `/model install <id>`: Provisions local model file.
* `/model remove <id>`: Safely deletes local model file from storage.

---

## 9. Security & Safety Rules

1. **HTTPS Only**: Rejects HTTP URLs and insecure redirects.
2. **SHA-256 Verification**: Verifies checksum prior to marking models READY.
3. **Non-Executable Storage**: Downloaded weights are parsed as passive tensor data; never executed as binary code.
4. **Path Traversal Shield**: File paths sanitized via `path.basename`.

---

## 10. Test Verification & Results

```bash
✓ npm run typecheck  # Passed with 0 errors
✓ npm run lint       # Passed with 0 errors
✓ npm run build      # Production build compiled cleanly
✓ vitest run modelProvisioningPhase4.test.ts  # 11/11 tests passed in 50ms
```

---

## 11. Remaining Work Before Release (Phase 5)

1. Finalize official production model CDN hosting endpoints.
2. Package prebuilt native `node-llama-cpp` platform binaries into release archives.
