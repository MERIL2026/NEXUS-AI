import type { ModelManifest } from './types.js';

export const DEFAULT_MODEL_MANIFESTS: Record<string, ModelManifest> = {
  'nexus-proto-0.5b': {
    id: 'nexus-proto-0.5b',
    displayName: 'NEXUS Prototype 0.5B (GGUF Q8_0)',
    version: '0.1.0-proto',
    format: 'gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf',
    sizeBytes: 390 * 1024 * 1024,
    sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0', // Test mock hash
    capabilities: ['fast-chat', 'lightweight-coding'],
    minimumRamMb: 1024,
    recommendedRamMb: 2048,
    tier: 'low',
    license: 'Apache-2.0',
    description: 'Lightweight 0.5B parameter model suitable for low-resource environments.',
  },
  'qwen2.5-coder-1.5b': {
    id: 'qwen2.5-coder-1.5b',
    displayName: 'Qwen2.5-Coder 1.5B Instruct (GGUF Q4_K_M)',
    version: '2.5.0',
    format: 'gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117143264,
    sha256: '1130d473cf2b5a1c0210f1107567ae2f38e079beae77a6a43d1a89045b376d8b',
    capabilities: ['code-synthesis', 'tool-execution', 'planning', 'chat'],
    minimumRamMb: 2048,
    recommendedRamMb: 4096,
    tier: 'standard',
    license: 'Apache-2.0',
    description: 'Recommended standard model balancing fast local code synthesis and low VRAM/RAM usage.',
  },
  'qwen2.5-coder-7b': {
    id: 'qwen2.5-coder-7b',
    displayName: 'Qwen2.5-Coder 7B Instruct (GGUF Q4_K_M)',
    version: '2.5.0',
    format: 'gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    sizeBytes: 4400 * 1024 * 1024,
    sha256: 'c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef012b',
    capabilities: ['advanced-coding', 'complex-reasoning', 'agent-orchestration'],
    minimumRamMb: 6144,
    recommendedRamMb: 8192,
    tier: 'high',
    license: 'Apache-2.0',
    description: 'High-performance 7B model for complex multi-file engineering and advanced reasoning tasks.',
  },
};

export class ModelManifestRegistry {
  private manifests = new Map<string, ModelManifest>();

  constructor(customManifests?: ModelManifest[]) {
    Object.values(DEFAULT_MODEL_MANIFESTS).forEach((m) => this.manifests.set(m.id, m));
    if (customManifests) {
      customManifests.forEach((m) => this.register(m));
    }
  }

  register(manifest: ModelManifest): void {
    if (!manifest.id || !manifest.downloadUrl || !manifest.sha256) {
      throw new Error(`Invalid manifest structure for '${manifest.id || 'unknown'}'`);
    }

    if (!manifest.downloadUrl.startsWith('https://')) {
      throw new Error(`Insecure download URL for manifest '${manifest.id}': must use HTTPS.`);
    }

    this.manifests.set(manifest.id, manifest);
  }

  getManifest(modelId: string): ModelManifest | null {
    return this.manifests.get(modelId) || null;
  }

  listManifests(): ModelManifest[] {
    return Array.from(this.manifests.values());
  }
}
