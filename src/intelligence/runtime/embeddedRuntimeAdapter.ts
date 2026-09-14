import type { AIRuntimeAdapter, RuntimeHealth, RuntimeModelInfo, ModelReadinessState, WarmupResult } from './types.js';
import type { GenerateOptions, GenerateResult, StreamChunk } from '../ollamaAdapter.js';
import { EmbeddedInferenceProvider } from '../providers/embeddedInferenceProvider.js';
import { Logger, LogLevel } from '../../common/logger.js';

export class EmbeddedRuntimeAdapter implements AIRuntimeAdapter {
  public readonly providerId = 'embedded' as const;
  private embeddedProvider: EmbeddedInferenceProvider;
  private logger: Logger;

  constructor(options: { modelPath?: string; modelName?: string; logLevel?: LogLevel } = {}) {
    this.logger = new Logger('EmbeddedRuntimeAdapter', options.logLevel || 'info');
    this.embeddedProvider = new EmbeddedInferenceProvider({
      modelPath: options.modelPath,
      modelName: options.modelName,
      logLevel: options.logLevel || 'info',
    });
  }

  getHost(): string {
    return 'embedded://in-process';
  }

  getEmbeddedProvider(): EmbeddedInferenceProvider {
    return this.embeddedProvider;
  }

  async checkHealth(_timeoutMs: number = 3000): Promise<RuntimeHealth> {
    try {
      const health = await this.embeddedProvider.healthCheck();
      return {
        providerId: 'embedded',
        status: health.status === 'READY' ? 'READY' : 'UNAVAILABLE',
        endpoint: 'embedded://in-process',
        version: health.version || '0.1.0-embedded',
        reason: health.status === 'READY' ? undefined : 'Embedded runtime unavailable',
        suggestedAction: health.status === 'READY' ? undefined : 'Verify embedded model installation',
        timestamp: health.timestamp,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        providerId: 'embedded',
        status: 'UNAVAILABLE',
        endpoint: 'embedded://in-process',
        reason: `Embedded runtime initialization error: ${msg}`,
        suggestedAction: 'Check local embedded runtime setup',
        timestamp: new Date().toISOString(),
      };
    }
  }

  async discoverModels(_timeoutMs: number = 5000): Promise<RuntimeModelInfo[]> {
    const models = await this.embeddedProvider.listModels();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      sizeBytes: m.sizeBytes,
      format: m.format,
      family: m.family,
      quantizationLevel: m.quantization,
      readiness: m.readiness === 'ready' ? 'MODEL_READY' : 'MODEL_UNAVAILABLE',
    }));
  }

  async checkModelReadiness(modelId: string, _timeoutMs: number = 3000): Promise<{ readiness: ModelReadinessState; details?: string }> {
    const models = await this.discoverModels();
    const found = models.find((m) => m.id === modelId || m.name === modelId);
    if (found) {
      return { readiness: 'MODEL_READY', details: `Model ${modelId} loaded in embedded runtime` };
    }
    return { readiness: 'MODEL_AVAILABLE', details: `Model ${modelId} supported by embedded runtime` };
  }

  async warmupModel(modelId: string, _timeoutMs: number = 5000): Promise<WarmupResult> {
    const start = Date.now();
    try {
      await this.embeddedProvider.generate({ model: modelId, prompt: 'ping' });
      return {
        success: true,
        modelId,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        modelId,
        latencyMs: Date.now() - start,
        error: String(err),
      };
    }
  }

  async generate(options: GenerateOptions, externalSignal?: AbortSignal): Promise<GenerateResult> {
    const res = await this.embeddedProvider.generate(
      {
        model: options.model,
        prompt: options.prompt,
        system: options.system,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      externalSignal
    );

    return {
      model: res.model,
      response: res.response,
      done: res.done,
      totalDurationMs: res.totalDurationMs,
      evalCount: res.completionTokens,
    };
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<GenerateResult> {
    const res = await this.embeddedProvider.streamChat(
      {
        model: options.model,
        messages: [
          ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
          { role: 'user' as const, content: options.prompt },
        ],
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      (c) => onChunk({ delta: c.delta, done: c.done }),
      externalSignal
    );

    return {
      model: res.model,
      response: res.message.content,
      done: res.done,
      totalDurationMs: res.totalDurationMs,
    };
  }
}
