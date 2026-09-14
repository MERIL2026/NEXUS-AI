import type {
  InferenceProvider,
  ProviderType,
  InferenceHealth,
  InferenceModelInfo,
  InferenceGenerateOptions,
  InferenceGenerateResult,
  InferenceChatOptions,
  InferenceChatResult,
  InferenceStreamChunk,
} from './inferenceProvider.js';
import { OllamaAdapter } from '../ollamaAdapter.js';
import { Logger, LogLevel } from '../../common/logger.js';

export class OllamaInferenceProvider implements InferenceProvider {
  public readonly providerType: ProviderType = 'ollama';
  private adapter: OllamaAdapter;
  private logger: Logger;

  constructor(
    private host: string = 'http://127.0.0.1:11434',
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('OllamaInferenceProvider', logLevel);
    this.adapter = new OllamaAdapter(this.host, logLevel);
  }

  async healthCheck(timeoutMs: number = 3000): Promise<InferenceHealth> {
    const health = await this.adapter.checkHealth(timeoutMs);
    return {
      providerType: this.providerType,
      status: health.available ? 'READY' : 'UNAVAILABLE',
      version: health.version,
      endpoint: this.host,
      details: { error: health.error },
      timestamp: new Date().toISOString(),
    };
  }

  async listModels(timeoutMs: number = 5000): Promise<InferenceModelInfo[]> {
    try {
      const rawModels = await this.adapter.discoverModels(timeoutMs);
      return rawModels.map((m) => ({
        id: m.name,
        name: m.name,
        sizeBytes: m.size,
        format: m.details?.format || 'gguf',
        family: m.details?.family,
        quantization: m.details?.quantization_level,
        readiness: 'ready',
      }));
    } catch (err) {
      this.logger.warn(`Failed listing models from Ollama: ${String(err)}`);
      return [];
    }
  }

  async getModelInfo(modelId: string): Promise<InferenceModelInfo | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) || null;
  }

  async generate(
    options: InferenceGenerateOptions,
    signal?: AbortSignal
  ): Promise<InferenceGenerateResult> {
    const res = await this.adapter.generate(
      {
        model: options.model,
        prompt: options.prompt,
        system: options.system,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      signal
    );

    return {
      model: res.model,
      response: res.response,
      done: res.done,
      totalDurationMs: res.totalDurationMs ?? 0,
      completionTokens: res.evalCount,
    };
  }

  async chat(
    options: InferenceChatOptions,
    signal?: AbortSignal
  ): Promise<InferenceChatResult> {
    const lastUserMsg = options.messages.filter((m) => m.role === 'user').pop();
    const prompt = lastUserMsg ? lastUserMsg.content : '';
    const system = options.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

    const genRes = await this.generate(
      {
        model: options.model,
        prompt,
        system: system || undefined,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      signal
    );

    return {
      model: genRes.model,
      message: { role: 'assistant', content: genRes.response },
      done: genRes.done,
      totalDurationMs: genRes.totalDurationMs,
      completionTokens: genRes.completionTokens,
    };
  }

  async streamChat(
    options: InferenceChatOptions,
    onChunk: (chunk: InferenceStreamChunk) => void,
    signal?: AbortSignal
  ): Promise<InferenceChatResult> {
    const lastUserMsg = options.messages.filter((m) => m.role === 'user').pop();
    const prompt = lastUserMsg ? lastUserMsg.content : '';
    const system = options.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

    const res = await this.adapter.generateStream(
      {
        model: options.model,
        prompt,
        system: system || undefined,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      (c) => onChunk({ delta: c.delta, done: c.done }),
      signal
    );

    return {
      model: res.model,
      message: { role: 'assistant', content: res.response },
      done: res.done,
      totalDurationMs: res.totalDurationMs ?? 0,
    };
  }

  async shutdown(): Promise<void> {
    this.logger.info('OllamaInferenceProvider shutdown called (no-op for external daemon)');
  }
}
