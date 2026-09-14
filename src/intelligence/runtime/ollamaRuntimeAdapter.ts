/**
 * NEXUS AI — Ollama Runtime Adapter (P7-B)
 *
 * Infrastructure layer connecting AIRuntimeAdapter abstraction to local Ollama daemon.
 * Provides deterministic health states, model readiness, bounded warm-up, and diagnostics.
 */

import { Logger, LogLevel } from '../../common/logger.js';
import { OllamaAdapter } from '../ollamaAdapter.js';
import type { GenerateOptions, GenerateResult, StreamChunk } from '../ollamaAdapter.js';
import type {
  AIRuntimeAdapter,
  RuntimeProviderId,
  RuntimeHealth,
  RuntimeModelInfo,
  ModelReadinessState,
  WarmupResult,
} from './types.js';

export class OllamaRuntimeAdapter implements AIRuntimeAdapter {
  readonly providerId: RuntimeProviderId = 'ollama';
  private logger: Logger;
  private adapter: OllamaAdapter;

  constructor(
    host: string = 'http://127.0.0.1:11434',
    logLevel: LogLevel = 'info',
    existingAdapter?: OllamaAdapter
  ) {
    this.logger = new Logger('OllamaRuntimeAdapter', logLevel);
    this.adapter = existingAdapter ?? new OllamaAdapter(host, logLevel);
  }

  getHost(): string {
    return this.adapter.getHost();
  }

  getUnderlyingAdapter(): OllamaAdapter {
    return this.adapter;
  }

  async checkHealth(timeoutMs: number = 3000): Promise<RuntimeHealth> {
    const host = this.getHost();
    const nowIso = new Date().toISOString();

    if (!host || !host.startsWith('http')) {
      return {
        providerId: 'ollama',
        status: 'NOT_CONFIGURED',
        endpoint: host || 'invalid',
        reason: 'OLLAMA_HOST endpoint is missing or malformed',
        suggestedAction: 'Configure OLLAMA_HOST environment variable with a valid http:// or https:// URL.',
        timestamp: nowIso,
      };
    }

    const health = await this.adapter.checkHealth(timeoutMs);

    if (!health.available) {
      const isConnRefused =
        health.error?.includes('ECONNREFUSED') ||
        health.error?.includes('fetch failed') ||
        health.error?.includes('connect ECONNREFUSED');

      return {
        providerId: 'ollama',
        status: isConnRefused ? 'UNREACHABLE' : 'UNAVAILABLE',
        endpoint: host,
        reason: health.error || 'Connection refused or daemon offline',
        suggestedAction: isConnRefused
          ? 'Start the local Ollama runtime process (run "ollama serve" or launch Ollama application).'
          : 'Check Ollama server logs and verify host endpoint.',
        timestamp: nowIso,
      };
    }

    return {
      providerId: 'ollama',
      status: 'READY',
      endpoint: host,
      version: health.version || 'unknown',
      timestamp: nowIso,
    };
  }

  async discoverModels(timeoutMs: number = 5000): Promise<RuntimeModelInfo[]> {
    try {
      const items = await this.adapter.discoverModels(timeoutMs);
      return items.map((item) => ({
        id: item.name,
        name: item.name,
        sizeBytes: item.size,
        modifiedAt: item.modified_at,
        digest: item.digest,
        format: item.details?.format,
        family: item.details?.family,
        parameterSize: item.details?.parameter_size,
        quantizationLevel: item.details?.quantization_level,
        readiness: 'MODEL_READY',
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Model discovery failed on Ollama runtime (${this.getHost()}): ${msg}`);
      return [];
    }
  }

  async checkModelReadiness(
    modelId: string,
    timeoutMs: number = 5000
  ): Promise<{ readiness: ModelReadinessState; details?: string }> {
    try {
      const models = await this.discoverModels(timeoutMs);
      const exists = models.some((m) => m.id === modelId || m.name === modelId);
      if (exists) {
        return { readiness: 'MODEL_READY' };
      }
      return {
        readiness: 'MODEL_NOT_INSTALLED',
        details: `Model '${modelId}' is not installed in local Ollama runtime.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        readiness: 'MODEL_ERROR',
        details: `Failed checking model readiness for '${modelId}': ${msg}`,
      };
    }
  }

  async warmupModel(
    modelId: string,
    timeoutMs: number = 5000,
    externalSignal?: AbortSignal
  ): Promise<WarmupResult> {
    const startTime = Date.now();
    this.logger.info(`Warming up model '${modelId}' on Ollama runtime...`);

    try {
      // Execute 1-token prompt for bounded warm-up
      await this.adapter.generate(
        {
          model: modelId,
          prompt: 'hi',
          temperature: 0.1,
          timeoutMs,
        },
        externalSignal
      );

      const latencyMs = Date.now() - startTime;
      this.logger.info(`Model '${modelId}' warm-up successful (${latencyMs}ms)`);
      return { success: true, modelId, latencyMs };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Model '${modelId}' warm-up failed (${latencyMs}ms): ${msg}`);
      return { success: false, modelId, latencyMs, error: msg };
    }
  }

  async generate(options: GenerateOptions, externalSignal?: AbortSignal): Promise<GenerateResult> {
    return this.adapter.generate(options, externalSignal);
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<GenerateResult> {
    return this.adapter.generateStream(options, onChunk, externalSignal);
  }
}
