/**
 * NEXUS AI — AI Runtime Manager (P7-B / Phase 3)
 *
 * Orchestrates runtime adapters (Embedded & Ollama), caches health checks & model discovery,
 * provides unified model readiness checking, auto-fallback provider selection, and inference dispatch.
 */

import { Logger, LogLevel } from '../../common/logger.js';
import type { GenerateOptions, GenerateResult, StreamChunk } from '../ollamaAdapter.js';
import type {
  AIRuntimeAdapter,
  RuntimeHealth,
  RuntimeModelInfo,
  ModelReadinessState,
  WarmupResult,
  RuntimeProviderId,
} from './types.js';
import { OllamaRuntimeAdapter } from './ollamaRuntimeAdapter.js';
import { EmbeddedRuntimeAdapter } from './embeddedRuntimeAdapter.js';

export type InferenceProviderConfigMode = 'embedded' | 'ollama' | 'auto';

export class AIRuntimeManager {
  private logger: Logger;
  private adapters = new Map<RuntimeProviderId, AIRuntimeAdapter>();
  private activeProviderId: RuntimeProviderId = 'embedded';
  private configMode: InferenceProviderConfigMode = 'auto';

  // Cache settings (TTL: 5000ms)
  private healthCache: { health: RuntimeHealth; cachedAt: number } | null = null;
  private modelCache: { models: RuntimeModelInfo[]; cachedAt: number } | null = null;
  private cacheTtlMs = 5000;

  constructor(
    defaultAdapter?: AIRuntimeAdapter,
    logLevel: LogLevel = 'info',
    configMode?: InferenceProviderConfigMode
  ) {
    this.logger = new Logger('AIRuntimeManager', logLevel);

    const envMode = (process.env.NEXUS_INFERENCE_PROVIDER as InferenceProviderConfigMode) || undefined;
    if (configMode) {
      this.configMode = configMode;
    } else if (envMode) {
      this.configMode = envMode;
    } else if (defaultAdapter && defaultAdapter.providerId !== 'embedded') {
      this.configMode = defaultAdapter.providerId as InferenceProviderConfigMode;
    } else {
      this.configMode = 'auto';
    }

    const embeddedAdapter = new EmbeddedRuntimeAdapter({ logLevel });
    const ollamaAdapter = (defaultAdapter && defaultAdapter.providerId === 'ollama')
      ? defaultAdapter
      : new OllamaRuntimeAdapter('http://127.0.0.1:11434', logLevel);

    this.registerAdapter(embeddedAdapter);
    this.registerAdapter(ollamaAdapter);

    if (this.configMode === 'ollama') {
      this.activeProviderId = 'ollama';
    } else {
      this.activeProviderId = 'embedded';
    }
  }

  registerAdapter(adapter: AIRuntimeAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
    this.logger.info(`Registered AI runtime provider '${adapter.providerId}' (Endpoint: ${adapter.getHost()})`);
  }

  getConfigMode(): InferenceProviderConfigMode {
    return this.configMode;
  }

  setConfigMode(mode: InferenceProviderConfigMode): void {
    this.configMode = mode;
    this.healthCache = null;
  }

  getActiveProviderId(): RuntimeProviderId {
    return this.activeProviderId;
  }

  setActiveProviderId(providerId: RuntimeProviderId): void {
    if (!this.adapters.has(providerId)) {
      throw new Error(`Cannot set active provider '${providerId}': not registered.`);
    }
    this.activeProviderId = providerId;
    this.healthCache = null;
  }

  getActiveAdapter(): AIRuntimeAdapter {
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter) {
      throw new Error(`Active AI runtime provider '${this.activeProviderId}' is not registered.`);
    }
    return adapter;
  }

  async getHealth(forceRefresh = false): Promise<RuntimeHealth> {
    const now = Date.now();
    if (!forceRefresh && this.healthCache && now - this.healthCache.cachedAt < this.cacheTtlMs) {
      return this.healthCache.health;
    }

    const envMode = (process.env.NEXUS_INFERENCE_PROVIDER as InferenceProviderConfigMode) || this.configMode || 'auto';

    if (envMode === 'embedded') {
      const embeddedAdapter = this.adapters.get('embedded');
      if (embeddedAdapter) {
        this.activeProviderId = 'embedded';
        const health = await embeddedAdapter.checkHealth(3000);
        this.healthCache = { health, cachedAt: now };
        return health;
      }
    } else if (envMode === 'ollama') {
      const ollamaAdapter = this.adapters.get('ollama');
      if (ollamaAdapter) {
        this.activeProviderId = 'ollama';
        const health = await ollamaAdapter.checkHealth(3000);
        this.healthCache = { health, cachedAt: now };
        return health;
      }
    } else {
      // AUTO mode: Try Embedded first, fall back to Ollama if Embedded is unavailable
      const embeddedAdapter = this.adapters.get('embedded');
      if (embeddedAdapter) {
        const embeddedHealth = await embeddedAdapter.checkHealth(3000);
        if (embeddedHealth.status === 'READY') {
          this.activeProviderId = 'embedded';
          this.healthCache = { health: embeddedHealth, cachedAt: now };
          return embeddedHealth;
        }
      }

      // Embedded unavailable -> Fallback to Ollama probe
      const ollamaAdapter = this.adapters.get('ollama');
      if (ollamaAdapter) {
        const ollamaHealth = await ollamaAdapter.checkHealth(3000);
        if (ollamaHealth.status === 'READY') {
          this.logger.warn('[RuntimeManager] Embedded runtime unavailable. Auto-falling back to Ollama runtime.');
          this.activeProviderId = 'ollama';
          this.healthCache = { health: ollamaHealth, cachedAt: now };
          return ollamaHealth;
        }
      }

      // Both unavailable
      const fallbackHealth: RuntimeHealth = {
        providerId: this.activeProviderId,
        status: 'UNAVAILABLE',
        endpoint: this.getActiveAdapter().getHost(),
        reason: 'Both Embedded runtime and Ollama service are unavailable',
        suggestedAction: 'Start embedded runtime or run Ollama service on http://127.0.0.1:11434',
        timestamp: new Date().toISOString(),
      };
      this.healthCache = { health: fallbackHealth, cachedAt: now };
      return fallbackHealth;
    }

    const adapter = this.getActiveAdapter();
    const health = await adapter.checkHealth(3000);
    this.healthCache = { health, cachedAt: now };
    return health;
  }

  getCachedHealth(): RuntimeHealth | null {
    return this.healthCache?.health ?? null;
  }

  async listModels(forceRefresh = false): Promise<RuntimeModelInfo[]> {
    const now = Date.now();
    if (!forceRefresh && this.modelCache && now - this.modelCache.cachedAt < this.cacheTtlMs) {
      return this.modelCache.models;
    }

    const adapter = this.getActiveAdapter();
    const models = await adapter.discoverModels(5000);
    this.modelCache = { models, cachedAt: now };
    return models;
  }

  async discoverAllModels(_forceRefresh = false): Promise<Array<{ model: RuntimeModelInfo; provider: RuntimeProviderId }>> {
    const results: Array<{ model: RuntimeModelInfo; provider: RuntimeProviderId }> = [];

    // 1. Embedded runtime models
    const embeddedAdapter = this.adapters.get('embedded');
    if (embeddedAdapter) {
      try {
        const embeddedModels = await embeddedAdapter.discoverModels(3000);
        for (const m of embeddedModels) {
          results.push({ model: m, provider: 'embedded' });
        }
      } catch (err) {
        this.logger.warn(`Failed discovering embedded models: ${String(err)}`);
      }
    }

    // 2. Ollama runtime models
    const ollamaAdapter = this.adapters.get('ollama');
    if (ollamaAdapter) {
      try {
        const health = await ollamaAdapter.checkHealth(3000);
        if (health.status === 'READY') {
          const ollamaModels = await ollamaAdapter.discoverModels(5000);
          for (const m of ollamaModels) {
            results.push({ model: m, provider: 'ollama' });
          }
        }
      } catch (err) {
        this.logger.warn(`Ollama model discovery skipped (offline/unreachable): ${String(err)}`);
      }
    }

    return results;
  }

  getAdapterForModel(modelId?: string): AIRuntimeAdapter {
    const embedded = this.adapters.get('embedded');
    const ollama = this.adapters.get('ollama');

    if (this.configMode === 'embedded') {
      return embedded || this.getActiveAdapter();
    }

    if (this.configMode === 'ollama') {
      return ollama || this.getActiveAdapter();
    }

    if (!modelId) {
      return this.getActiveAdapter();
    }

    const lower = modelId.toLowerCase();
    const isEmbeddedModel =
      lower.includes('1.5b') ||
      lower.includes('proto') ||
      lower.includes('micro') ||
      lower.includes('nexus-embedded') ||
      lower.includes('embedded');

    if (isEmbeddedModel) {
      return embedded || this.getActiveAdapter();
    }

    // For standard external models (e.g. llama3.1:8b, qwen2.5-coder:7b, deepseek-r1:8b, qwen2.5:3b, mistral, etc.)
    if (ollama) {
      return ollama;
    }

    return this.getActiveAdapter();
  }

  async checkModelReadiness(modelId: string): Promise<{ readiness: ModelReadinessState; details?: string }> {
    const adapter = this.getAdapterForModel(modelId);
    return adapter.checkModelReadiness(modelId);
  }

  async warmupModel(modelId: string, timeoutMs: number = 5000): Promise<WarmupResult> {
    const adapter = this.getAdapterForModel(modelId);
    return adapter.warmupModel(modelId, timeoutMs);
  }

  async generate(options: GenerateOptions, externalSignal?: AbortSignal): Promise<GenerateResult> {
    const adapter = this.getAdapterForModel(options.model);
    return adapter.generate(options, externalSignal);
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<GenerateResult> {
    const adapter = this.getAdapterForModel(options.model);
    return adapter.generateStream(options, onChunk, externalSignal);
  }
}
